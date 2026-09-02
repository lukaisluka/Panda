"""CLI 入口。

- `serve`(默认建议):WebSocket 桥,每条连接一个 stdio 子进程,供 Panda 直连
- `stdio`:官方 deepagents-acp 的裸 stdio 模式,供桥内部使用,也可直接接 Zed
  等编辑器调试 agent 本身
"""

from __future__ import annotations

import argparse
import asyncio
import logging
import sys
from pathlib import Path

from dotenv import load_dotenv

from panda_test_agent.serve import (
    AGENT_ROOT,
    DEFAULT_SANDBOX_DIR,
    DEFAULT_SEED_DIR,
    DEFAULT_STATE_DIR,
)

LOG_FORMAT = "[%(asctime)s] %(levelname)s %(name)s: %(message)s"


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="panda-test-agent",
        description="Panda 的测试专用 ACP agent(deepagents + deepagents-acp)",
    )
    sub = parser.add_subparsers(dest="command", required=True)

    serve_p = sub.add_parser("serve", help="WebSocket 桥(供 Panda 直连)")
    serve_p.add_argument("--host", default="127.0.0.1")
    serve_p.add_argument("--port", type=int, default=8766)
    serve_p.add_argument(
        "--sandbox-dir",
        type=Path,
        default=DEFAULT_SANDBOX_DIR,
        help=f"agent 的文件沙箱(默认 {DEFAULT_SANDBOX_DIR})",
    )
    serve_p.add_argument(
        "--state-dir",
        type=Path,
        default=DEFAULT_STATE_DIR,
        help=f"SQLite checkpointer 等持久化状态(默认 {DEFAULT_STATE_DIR})",
    )
    serve_p.add_argument(
        "--seed-dir",
        type=Path,
        default=DEFAULT_SEED_DIR,
        help="启动时用于重置沙箱的种子项目",
    )
    serve_p.add_argument(
        "--keep-sandbox",
        action="store_true",
        help="启动时不重置沙箱(默认每次启动从 seed 重置)",
    )

    stdio_p = sub.add_parser("stdio", help="以 ACP stdio 模式运行(供桥/Zed 使用)")
    stdio_p.add_argument("--sandbox-dir", type=Path, default=DEFAULT_SANDBOX_DIR)
    stdio_p.add_argument("--state-dir", type=Path, default=DEFAULT_STATE_DIR)
    return parser


async def _run_stdio(sandbox_dir: Path, state_dir: Path) -> None:
    from acp import run_agent

    from panda_test_agent.agent import create_acp_agent
    from panda_test_agent.serve import reset_sandbox

    # 裸 stdio 在全新 clone 里也必须可直接运行；已有沙箱则保留，避免编辑器
    # 重连时悄悄抹掉上一条连接产生的文件改动。
    if not sandbox_dir.exists():
        reset_sandbox(DEFAULT_SEED_DIR, sandbox_dir)

    acp_agent = await create_acp_agent(sandbox_dir, state_dir)
    await run_agent(acp_agent)


def main() -> None:
    args = _build_parser().parse_args()

    # 日志只写 stderr:stdio 模式下 stdout 是协议通道,绝不能混入日志
    logging.basicConfig(level=logging.INFO, stream=sys.stderr, format=LOG_FORMAT)
    # 依赖库太吵的话在这里降噪,但保留我们自己包的 INFO
    logging.getLogger("httpx").setLevel(logging.WARNING)
    logging.getLogger("openai").setLevel(logging.WARNING)

    load_dotenv(AGENT_ROOT / ".env")

    if args.command == "stdio":
        asyncio.run(_run_stdio(args.sandbox_dir, args.state_dir))
    else:
        from panda_test_agent import serve as serve_mod

        serve_mod.main(
            host=args.host,
            port=args.port,
            sandbox_dir=args.sandbox_dir,
            state_dir=args.state_dir,
            seed_dir=args.seed_dir,
            keep_sandbox=args.keep_sandbox,
        )


if __name__ == "__main__":
    main()
