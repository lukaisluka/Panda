"""WebSocket ↔ stdio 桥:Panda 是 WebSocket 客户端,而 deepagents-acp 官方
`run_agent` 只支持 stdio(ACP stdio 为行分隔 JSON-RPC;Panda 的 WebSocket
约定是每文本帧一条 JSON-RPC)。

每条 WebSocket 连接 spawn 一个 `python -m panda_test_agent stdio` 子进程,
与 Zed 消费 ACP agent 的方式一致;本模块只做"文本帧 ↔ 行"的哑转发,不解析
协议。子进程 stdout 里混入的非 JSON 行会被过滤并记录日志(有些库不守规矩往
stdout print,不能让它们破坏协议流);stderr 原样透传到终端,保持可观测。
"""

from __future__ import annotations

import asyncio
import json
import logging
import shutil
import sys
from pathlib import Path
from typing import Any

from websockets.asyncio.server import serve

AGENT_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_SEED_DIR = AGENT_ROOT / "seed"
DEFAULT_SANDBOX_DIR = AGENT_ROOT / "sandbox"
DEFAULT_STATE_DIR = AGENT_ROOT / ".state"

_TERMINATE_TIMEOUT_S = 5.0
logger = logging.getLogger("panda_test_agent.serve")


def reset_sandbox(seed_dir: Path, sandbox_dir: Path) -> None:
    """把沙箱重置为种子项目的副本,保证剧本的 edit_file 每次都能命中。"""
    seed_dir = seed_dir.resolve()
    if not seed_dir.is_dir():
        raise FileNotFoundError(f"种子目录不存在: {seed_dir}")
    if sandbox_dir.exists():
        shutil.rmtree(sandbox_dir)
    sandbox_dir.parent.mkdir(parents=True, exist_ok=True)
    shutil.copytree(seed_dir, sandbox_dir)
    logger.info("沙箱已重置: %s <- %s", sandbox_dir, seed_dir)


async def _pump_inbound(websocket: Any, stdin: asyncio.StreamWriter) -> None:
    """WebSocket 文本帧 → 子进程 stdin(每帧一行)。"""
    async for frame in websocket:
        if not isinstance(frame, str):
            logger.warning("忽略二进制帧(%d 字节)", len(frame))
            continue
        stdin.write((frame + "\n").encode("utf-8"))
        await stdin.drain()


async def _pump_outbound(stdout: asyncio.StreamReader, websocket: Any, pid: int) -> None:
    """子进程 stdout 行 → WebSocket 文本帧;过滤掉非 JSON-RPC 的输出。"""
    while True:
        line = await stdout.readline()
        if not line:
            return
        text = line.decode("utf-8", errors="replace").strip()
        if not text:
            continue
        try:
            json.loads(text)
        except json.JSONDecodeError:
            logger.warning("[pid %d] 丢弃子进程的非 JSON stdout 行: %s", pid, text[:200])
            continue
        await websocket.send(text)


async def _terminate(proc: asyncio.subprocess.Process) -> None:
    if proc.returncode is not None:
        return
    proc.terminate()
    try:
        await asyncio.wait_for(proc.wait(), timeout=_TERMINATE_TIMEOUT_S)
    except TimeoutError:
        logger.warning("[pid %d] SIGTERM 后 %ss 未退出,改用 SIGKILL", proc.pid, _TERMINATE_TIMEOUT_S)
        proc.kill()
        await proc.wait()


async def _handle_connection(
    websocket: Any,
    *,
    sandbox_dir: Path,
    state_dir: Path,
) -> None:
    """一条 WebSocket 连接 = 一个 stdio agent 子进程。"""
    proc = await asyncio.create_subprocess_exec(
        sys.executable,
        "-m",
        "panda_test_agent",
        "stdio",
        "--sandbox-dir",
        str(sandbox_dir),
        "--state-dir",
        str(state_dir),
        stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE,
        # stderr 不接管:子进程日志直接透传到当前终端
    )
    assert proc.stdin is not None and proc.stdout is not None
    logger.info("[pid %d] 连接进入,agent 子进程已启动", proc.pid)

    inbound_task = asyncio.create_task(
        _pump_inbound(websocket, proc.stdin), name=f"ws-to-stdio-{proc.pid}"
    )
    outbound_task = asyncio.create_task(
        _pump_outbound(proc.stdout, websocket, proc.pid), name=f"stdio-to-ws-{proc.pid}"
    )
    try:
        done, _pending = await asyncio.wait(
            {inbound_task, outbound_task}, return_when=asyncio.FIRST_COMPLETED
        )
        # Surface pump failures instead of turning a broken bridge into a hang.
        for task in done:
            task.result()

        if outbound_task in done and not inbound_task.done():
            await proc.wait()
            reason = f"agent 子进程已退出(退出码 {proc.returncode})"
            logger.error("[pid %d] %s", proc.pid, reason)
            await websocket.close(code=1011 if proc.returncode else 1000, reason=reason)
    finally:
        for task in (inbound_task, outbound_task):
            if not task.done():
                task.cancel()
        await asyncio.gather(inbound_task, outbound_task, return_exceptions=True)
        await _terminate(proc)
        await websocket.close()
        logger.info("[pid %d] 连接结束,agent 子进程退出码 %s", proc.pid, proc.returncode)


async def run_serve(
    *,
    host: str,
    port: int,
    sandbox_dir: Path,
    state_dir: Path,
    seed_dir: Path,
    keep_sandbox: bool,
) -> None:
    """启动 WebSocket 桥,直到被中断。"""
    if not keep_sandbox:
        reset_sandbox(seed_dir, sandbox_dir)

    async def handler(websocket: Any) -> None:
        await _handle_connection(websocket, sandbox_dir=sandbox_dir, state_dir=state_dir)

    # ACP 不限定路径,Panda 连 ws://host:port/acp 或任意路径均可
    async with serve(handler, host, port, max_size=16 * 1024 * 1024):
        logger.info(
            "Panda 测试 agent 已就绪: ws://%s:%s/acp(沙箱: %s)", host, port, sandbox_dir
        )
        await asyncio.Future()  # 永久运行,直到 Ctrl+C


def main(
    *,
    host: str,
    port: int,
    sandbox_dir: Path,
    state_dir: Path,
    seed_dir: Path,
    keep_sandbox: bool,
) -> None:
    try:
        asyncio.run(
            run_serve(
                host=host,
                port=port,
                sandbox_dir=sandbox_dir,
                state_dir=state_dir,
                seed_dir=seed_dir,
                keep_sandbox=keep_sandbox,
            )
        )
    except KeyboardInterrupt:
        logger.info("收到中断,退出")
