import { CircleCheckBig, Link2 } from 'lucide-react';
import { Button } from '@astryxdesign/core/Button';
import type { ElicitationResponse } from '../protocol/types';
import type { AttachedElicitation } from '../projector/messageStream';
import './ElicitationCard.css';

/**
 * The url-mode elicitation card: the agent directs the user to an external
 * flow (`elicitation/create`, url mode — OAuth and friends). Consent is the
 * user's only decision: accepting opens the link (the RPC answers accept and
 * ends there — completion is out-of-band) and the card then waits for the
 * agent's `elicitation/complete` notification. The spec's display duties are
 * done here: full URL, highlighted host, punycode/plain-http warnings.
 */
export function ElicitationUrlCard({ elicitation, onOpen, onDecline }: {
  elicitation: AttachedElicitation;
  onOpen: (id: string) => void;
  onDecline: (id: string, response: ElicitationResponse) => void;
}) {
  if (elicitation.request.mode !== 'url') return null; // form renders via ElicitationCard
  const request = elicitation.request;

  if (elicitation.state === 'settled') {
    const response = elicitation.response;
    const summary = !response
      ? '已完成'
      : response.outcome === 'declined'
        ? '已拒绝'
        : '已取消(非用户决定)';
    return (
      <div className="elicit-card elicit-card--settled">
        <div className="elicit-head elicit-head--settled">
          <CircleCheckBig size={14} />
          外部授权 · {summary}
        </div>
      </div>
    );
  }

  if (elicitation.state === 'opened') {
    return (
      <div className="elicit-card">
        <div className="elicit-head">
          <Link2 size={14} />
          外部授权
        </div>
        {request.message && <p className="elicit-title">{request.message}</p>}
        <p className="elicit-desc">链接已打开,等待外部流程完成…</p>
        <p className="elicit-url">{request.url}</p>
      </div>
    );
  }

  const safety = urlSafety(request.url);
  return (
    <div className="elicit-card">
      <div className="elicit-head">
        <Link2 size={14} />
        Agent 请求信息(外部授权)
      </div>
      {request.message && <p className="elicit-title">{request.message}</p>}
      <div className="elicit-url-box">
        {safety.host && <span className="elicit-url-host">{safety.host}</span>}
        <span className="elicit-url">{request.url}</span>
      </div>
      {safety.punycode && <p className="elicit-warn">域名含 Punycode(xn--),谨防仿冒站点</p>}
      {safety.insecure && <p className="elicit-warn">链接不是 HTTPS,传输不受保护</p>}
      {!safety.host && <p className="elicit-warn">链接无法解析,已禁用打开</p>}
      <p className="elicit-desc">点击后将在你的浏览器新标签页打开,授权在外部页面完成。</p>
      <div className="elicit-actions">
        <Button size="sm" variant="secondary" label="拒绝" clickAction={() => onDecline(request.id, { outcome: 'declined' })} />
        <Button
          size="sm"
          variant="primary"
          label="打开链接"
          isDisabled={!safety.host}
          clickAction={() => {
            // Must stay synchronous in the click gesture — an async
            // window.open (after the RPC round-trip) gets popup-blocked.
            window.open(request.url, '_blank', 'noopener,noreferrer');
            onOpen(request.id);
          }}
        />
      </div>
    </div>
  );
}

/**
 * Consent-card readout of where the link really goes: host for the
 * highlight, punycode labels for look-alike domains, plain http off
 * localhost for unencrypted transport. Unparseable URLs disable opening
 * rather than firing a broken navigation.
 */
function urlSafety(url: string): { host: string | null; punycode: boolean; insecure: boolean } {
  try {
    const parsed = new URL(url);
    const localhost = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1';
    return {
      host: parsed.host,
      punycode: parsed.hostname.split('.').some((label) => label.startsWith('xn--')),
      insecure: parsed.protocol === 'http:' && !localhost,
    };
  } catch {
    return { host: null, punycode: false, insecure: false };
  }
}
