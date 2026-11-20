import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, Check, LockKeyhole, X } from 'lucide-react';
import './paywall.css';

type PaywallProps = { onSkip: () => void; onBack?: () => void };
type Plan = 'Max' | 'Premium';
const planNames: Record<Plan, string> = { Max: 'StudyC全能版', Premium: 'StudyC进阶版' };

const benefits: Record<Plan, string[]> = {
  Max: ['内置知识点练习', '更多小C辅导模式，例如屏幕共享和摄像头', '每月更多讲解视频', '更自然的语音'],
  Premium: ['不限量闪卡和模拟测试', '无限上传各种类型的文件', '小C辅导课程', '标准讲解视频'],
};

export default function Paywall({ onSkip, onBack }: PaywallProps) {
  const [annual, setAnnual] = useState(true);
  const [plan, setPlan] = useState<Plan>('Premium');
  const [couponOpen, setCouponOpen] = useState(false);
  const [coupon, setCoupon] = useState('');
  const [couponStatus, setCouponStatus] = useState('');
  const [review, setReview] = useState<'self' | 'parent' | null>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const prices: Record<Plan, string> = annual ? { Max: '18.75', Premium: '8' } : { Max: '50', Premium: '19' };

  useEffect(() => {
    if (review) dialogRef.current?.showModal();
    else dialogRef.current?.close();
  }, [review]);

  return (
    <main className="sf-paywall">
      <nav className="sf-paywall-nav" aria-label="方案导航">
        <button type="button" className="sf-paywall-back" onClick={onBack ?? onSkip}><ArrowLeft size={18} strokeWidth={1.7} />返回</button>
        <button type="button" className="sf-paywall-skip" onClick={onSkip}>暂时跳过</button>
      </nav>

      <div className="sf-paywall-layout">
        <aside className="sf-paywall-story">
          <div className="sf-paywall-illustration">
            <img src="/assets/studyc/student-at-desk.svg" alt="学习伙伴陪伴学习者在书桌前学习" />
          </div>
          <blockquote className="sf-paywall-quote">
            <p>“把每天不懂的地方弄明白，学习也可以变得更轻松。”</p>
            <footer>学习体验示例</footer>
          </blockquote>
        </aside>

        <section className="sf-paywall-options" aria-labelledby="sf-paywall-title">
          <h1 id="sf-paywall-title">选择你的 StudyC 方案</h1>
          <div className="sf-billing-switch" role="radiogroup" aria-label="计费周期">
            <button type="button" role="radio" aria-checked={annual} className={annual ? 'is-selected' : ''} onClick={() => setAnnual(true)}>
              <span className="sf-annual-saving">最高节省 50%</span>按年
            </button>
            <button type="button" role="radio" aria-checked={!annual} className={!annual ? 'is-selected' : ''} onClick={() => setAnnual(false)}>按月</button>
          </div>

          <div className="sf-plan-list" role="radiogroup" aria-label="选择方案">
            {(['Max', 'Premium'] as const).map((item) => (
              <button key={item} type="button" role="radio" aria-checked={plan === item} className={`sf-plan-card ${plan === item ? 'is-selected' : ''}`} onClick={() => setPlan(item)}>
                <span className="sf-plan-head">
                  <span className={`sf-plan-radio ${plan === item ? 'is-selected' : ''}`}>{plan === item && <Check size={16} strokeWidth={2} />}</span>
                  <span className="sf-plan-name"><strong>{planNames[item]}</strong><span>{item === 'Max' ? '进阶版全部功能，以及更强大的 AI 工具' : '高效学习所需的一切'}</span></span>
                  <span className="sf-plan-price"><span><strong>${prices[item]}</strong><span>/月</span></span><small>{annual ? `每年收取 $${item === 'Max' ? '225' : '96'}` : '按月计费'}</small></span>
                </span>
                <span className="sf-plan-divider" />
                <span className="sf-plan-benefit-label">{item === 'Max' ? `${planNames.Premium}的全部功能，另加：` : `${planNames.Premium}包含：`}</span>
                <span className="sf-plan-benefits">{benefits[item].map((text) => <span key={text}><Check size={16} strokeWidth={1.7} /><span>{text}</span></span>)}</span>
              </button>
            ))}
          </div>

          <button type="button" className="sf-paywall-continue" onClick={() => setReview('self')}>继续选择 {planNames[plan]} {annual ? '按年' : '按月'}</button>
          <button type="button" className="sf-paywall-parent" onClick={() => setReview('parent')}>请他人代付</button>
          <button type="button" className="sf-paywall-coupon-toggle" aria-expanded={couponOpen} onClick={() => { setCouponOpen((open) => !open); setCouponStatus(''); }}>有优惠码吗？</button>
          {couponOpen && <form className="sf-coupon-form" onSubmit={(event) => { event.preventDefault(); setCouponStatus(coupon.trim() ? '演示页面暂不支持兑换优惠码。' : '请输入优惠码。'); }}>
            <label className="sf-visually-hidden" htmlFor="sf-coupon">优惠码</label>
            <input id="sf-coupon" value={coupon} onChange={(event) => setCoupon(event.target.value)} placeholder="输入优惠码" autoComplete="off" />
            <button type="submit">应用</button>
            {couponStatus && <p role="status">{couponStatus}</p>}
          </form>}
          <p className="sf-paywall-secure"><LockKeyhole size={13} />安全结账 · 可随时取消</p>
        </section>
      </div>

      <dialog className="sf-checkout-dialog" ref={dialogRef} onCancel={() => setReview(null)} onClick={(event) => { if (event.target === event.currentTarget) setReview(null); }}>
        <button type="button" className="sf-dialog-close" aria-label="关闭" onClick={() => setReview(null)}><X size={20} /></button>
        <h2>{review === 'parent' ? '与代付人一起了解学习方案' : '确认学习方案'}</h2>
        <div className="sf-checkout-summary"><span>{planNames[plan]} · {annual ? '按年' : '按月'}</span><strong>${annual ? (plan === 'Max' ? '225' : '96') : prices[plan]}<small>/{annual ? '年' : '月'}</small></strong></div>
        <p>演示页面，暂未接入支付。</p>
        <p className="sf-checkout-help">当前为方案预览，不会创建订单、扣款或向他人发送消息。</p>
        <button type="button" className="sf-paywall-continue" onClick={() => { setReview(null); onSkip(); }}>继续体验学习空间</button>
      </dialog>
    </main>
  );
}
