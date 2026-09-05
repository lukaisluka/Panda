import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import './ClampBox.css';

/**
 * 展开区长内容钳制(#83):超过限高后渐隐截断 + 「展开全部/收起」。
 * 应用于工具卡展开区的每个内容块(原始 JSON、代码预览、diff、文本输出)
 * ——此前除 unsupported 兜底外没有任何限高,一个 2000 行的读文件结果
 * 能把卡片和虚拟列表一起撑爆。
 *
 * max-height 常驻在 body 上(而非只在钳制态加上):溢出检测靠
 * scrollHeight > clientHeight,若未钳制时高度不受限,两个值永远相等,
 * 检测本身永远不会触发。钳制态只额外叠加 overflow + 渐隐。溢出一经检出
 * 按钮就粘住——展开后自然高度恢复,若重算按钮会消失,用户将无法收起。
 * jsdom 没有布局(scrollHeight 恒 0),单测里按钮永不出现,钳制行为靠
 * 浏览器实测。
 */
export function ClampBox({ children }: { children: ReactNode }) {
  const bodyRef = useRef<HTMLDivElement>(null);
  const [overflows, setOverflows] = useState(false);
  const [expanded, setExpanded] = useState(false);

  useLayoutEffect(() => {
    const el = bodyRef.current;
    if (!el) return undefined;
    const check = () => {
      if (el.scrollHeight > el.clientHeight + 1) setOverflows(true);
    };
    check();
    const observer = new ResizeObserver(check);
    // body 的盒子高度被 max-height 钉死,内容长高不会改变它——必须同时
    // 观察内容子元素,流式追加/图片加载才有信号触发复核。
    observer.observe(el);
    for (const child of el.children) observer.observe(child);
    return () => observer.disconnect();
  }, []);

  const clamped = overflows && !expanded;

  return (
    <div className={`tool-clamp${clamped ? ' tool-clamp--clamped' : ''}${expanded ? ' tool-clamp--expanded' : ''}`}>
      <div ref={bodyRef} className="tool-clamp-body">
        {children}
      </div>
      {overflows && (
        <button
          type="button"
          className="tool-clamp-toggle"
          onClick={() => setExpanded((e) => !e)}
        >
          {expanded ? '收起' : '展开全部'}
        </button>
      )}
    </div>
  );
}
