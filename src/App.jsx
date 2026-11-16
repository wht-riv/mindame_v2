import React, { useEffect, useMemo, useRef, useState } from 'react';
import { addDoc, collection, deleteDoc, doc, getDoc, getDocs, limit, query, serverTimestamp, setDoc, Timestamp, updateDoc, where } from 'firebase/firestore';
import { db, firebaseReady, ensureAnonymousUser } from './firebase.js';

const APP_VERSION = '6.1.0';

const EXCUSES = [
  '眠い・だるい',
  '疲れた',
  '面倒くさい',
  '時間がない',
  'あとでやる',
  'スマホを見続けてしまう',
  '布団から出られない',
  'どこから手をつけるか分からない',
  '全部やるのが大変',
  '今日は無理'
];

const STEPS = [
  'ゴミを1つ捨てる',
  '服を1枚片付ける',
  '食器を1枚洗う',
  '机の上のものを1つ戻す',
  'カーテンを開ける',
  '布団から出る',
  '洗面所に行く',
  '歯を磨く',
  'スマホを置く',
  'タイマーを3分かける'
];

const INTENTION_PRESETS = [
  '机の上を片付けたい',
  '洗濯物をしまいたい',
  '食器を洗いたい',
  'お風呂に入りたい',
  '朝食を用意したい',
  'ゴミをまとめたい'
];

const REACTIONS = [
  { id: 'wakaru', label: 'わかる', icon: '🤲' },
  { id: 'sankou', label: '参考になる', icon: '💡' },
  { id: 'dekisou', label: 'できそう', icon: '👣' }
];

const LIMITS = { intention: 80, excuse: 60, step: 80 };
const SK = 'mindameParticipantCodeV53';
const clean = v => v.trim().toUpperCase().replace(/[^A-Z0-9_-]/g, '').slice(0, 20);
const uniq = xs => xs.filter((x, i, a) => x && a.indexOf(x) === i);

// URL ?demo=1 でデモモード初期値を決定
const urlDemo = new URLSearchParams(window.location.search).get('demo') === '1';

// ---- 生活日（Asia/Tokyo・毎朝4:00境界）----
const HOUR_MS = 60 * 60 * 1000;
const jstDateFormat = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Tokyo' });
// 0:00〜3:59 は前日の生活日
const getLifeDate = (date = new Date()) => jstDateFormat.format(new Date(date.getTime() - 4 * HOUR_MS));
const lifeDateToStart = lifeDate => new Date(`${lifeDate}T04:00:00+09:00`);
const getLifeDayStart = (date = new Date()) => lifeDateToStart(getLifeDate(date));
const getNextLifeDayStart = (date = new Date()) => new Date(getLifeDayStart(date).getTime() + 24 * HOUR_MS);
const today = () => getLifeDate();

const tsToMs = v => {
  if (!v) return null;
  if (typeof v.toMillis === 'function') return v.toMillis();
  if (typeof v.seconds === 'number') return v.seconds * 1000;
  const t = new Date(v).getTime();
  return Number.isNaN(t) ? null : t;
};

// 振り返り可能時刻 = 「次の生活日の4:00」と「作戦登録から6時間後」の遅いほう
function getReviewAvailableMs(record) {
  const saved = tsToMs(record.reviewAvailableAt);
  if (saved) return saved;
  const created = tsToMs(record.createdAt);
  const lifeDate = record.recordDate || (created ? getLifeDate(new Date(created)) : null);
  if (!lifeDate) return null;
  const next = lifeDateToStart(lifeDate).getTime() + 24 * HOUR_MS;
  return created ? Math.max(next, created + 6 * HOUR_MS) : next;
}

function isReviewLocked(record, demoMode) {
  if (!record || demoMode) return false;
  const ms = getReviewAvailableMs(record);
  return ms ? Date.now() < ms : false;
}
// ---- 旧データ互換 ----
const normalizeOutcome = s => {
  if (s === 'done' || s === 'acted') return 'done';
  if (s === 'partial') return 'partial';
  if (s === 'not_started' || s === 'not_done') return 'not_started';
  return null; // changed / unknown / null は主要集計対象外
};
const intentionOf = r => (r && (r.dailyIntentionText || r.goalText)) || '登録された行動';
const normalizeReactionType = t => (t === 'seed' ? 'dekisou' : t);

export default function App() {
  const sessionStart = useRef(new Date());
  const reviewOpenedAt = useRef(null);
  const reviewStartSaved = useRef(false);
  const [ready, setReady] = useState(false);
  const [authFailed, setAuthFailed] = useState(false);
  const [uid, setUid] = useState('');
  const [code, setCode] = useState(localStorage.getItem(SK) || '');
  const [codeIn, setCodeIn] = useState('');
  const [profile, setProfile] = useState(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [records, setRecords] = useState([]);
  const [posts, setPosts] = useState([]);
  const [tab, setTab] = useState('home');
  const [flow, setFlow] = useState(null);
  const [shareDraft, setShareDraft] = useState(null);
  const [toast, setToast] = useState('');
  const [demoMode, setDemoMode] = useState(urlDemo);

  const msg = t => { setToast(t); setTimeout(() => setToast(''), 2200) };
  const toggleDemo = () => setDemoMode(v => !v);

  // エラーログ（個人情報・入力内容は保存しない。失敗しても再帰しない）
  async function logError(errorType, operation, err) {
    console.error('App error:', errorType, operation, err && err.code);
    try {
      if (!uid) return;
      await addDoc(collection(db, 'systemErrorsV1'), {
        uid,
        participantCode: code || null,
        errorType,
        operation,
        message: String((err && err.code) || 'unknown').slice(0, 60),
        appVersion: APP_VERSION,
        createdAt: serverTimestamp()
      });
    } catch (e) {
      console.error('Error log failed:', e && e.code);
    }
  }

  // イベントログ（必要最小限。once指定は生活日につき1回）
  async function logEvent(eventType, extra = {}) {
    try {
      if (!uid || !code) return;
      const recordDate = getLifeDate();
      const data = {
        participantCode: code,
        eventType,
        recordId: extra.recordId || null,
        postId: extra.postId || null,
        reactionType: extra.reactionType || null,
        recordDate,
        appVersion: APP_VERSION,
        createdAt: serverTimestamp()
      };
      const col = collection(db, 'participantsV4', uid, 'events');
      if (extra.once) {
        const ref = doc(col, `${recordDate}_${eventType}`);
        const exists = await getDoc(ref);
        if (exists.exists()) return;
        await setDoc(ref, data);
      } else {
        await addDoc(col, data);
      }
    } catch (e) {
      console.error('Event log failed:', e && e.code);
    }
  }

  useEffect(() => {
    if (!firebaseReady) return;
    ensureAnonymousUser()
      .then(u => { setUid(u.uid); setReady(true) })
      .catch(e => { console.error('Auth error:', e && e.code); setAuthFailed(true) });
  }, []);
  useEffect(() => { if (ready && uid && code) loadAll() }, [ready, uid, code]);
  useEffect(() => { const f = () => { if (uid && code && !flow) loadAll() }; document.addEventListener('visibilitychange', f); return () => document.removeEventListener('visibilitychange', f) }, [uid, code, flow]);
  useEffect(() => { if (profile && uid && code) logEvent('app_opened', { once: true }) }, [!!profile, uid, code]);

  async function loadAll() {
    setLoading(true);
    try {
      const pr = doc(db, 'participantsV4', uid), ps = await getDoc(pr);
      setProfile(ps.exists() ? ps.data() : null);
      if (ps.exists()) {
        const rs = await getDocs(collection(pr, 'records'));
        setRecords(rs.docs.map(x => ({ id: x.id, ...x.data() })).sort((a, b) => (b.recordDate || '').localeCompare(a.recordDate || '')));
      }
    } catch (e) {
      logError('read', 'loadAll', e);
      msg('読み込めませんでした。');
    }
    setLoading(false);
  }

  function enter() { const c = clean(codeIn); if (c.length < 3) return msg('参加コードを確認してください。'); localStorage.setItem(SK, c); setCode(c) }

  async function onboard(v) {
    try {
      const base = {
        ownerUid: uid,
        participantCode: code,
        customExcuses: v.excuses,
        savedFirstSteps: STEPS,
        appVersion: APP_VERSION
      };
      await setDoc(doc(db, 'participantsV4', uid), { ...base, consentedAt: serverTimestamp(), createdAt: serverTimestamp(), updatedAt: serverTimestamp() });
      setProfile(base);
    } catch (e) {
      logError('write', 'onboard', e);
      msg('保存できませんでした。');
    }
  }

  const pending = records.find(r => !r.outcomeStatus) || null;
  const todayRecord = records.find(r => r.recordDate === today()) || null;
  const current = demoMode ? pending : todayRecord;
  const pendingLocked = isReviewLocked(pending, demoMode);
  const planBlocked = !demoMode && !!todayRecord;

  function openPlan() {
    if (planBlocked) return;
    setFlow('plan');
    logEvent('plan_opened');
  }

  async function savePlan(v) {
    if (saving) return;
    const intention = v.intention.trim(), excuse = v.excuse.trim(), step = v.step.trim();
    if (!intention || intention.length > LIMITS.intention || !excuse || excuse.length > LIMITS.excuse || !step || step.length > LIMITS.step) return;
    setSaving(true);
    try {
      const now = new Date();
      const lifeDate = getLifeDate(now);
      if (!demoMode && records.some(r => r.recordDate === lifeDate)) { msg('今日の作戦は記録済みです。'); setFlow(null); return; }
      const id = demoMode ? `${lifeDate}-${now.getTime()}` : lifeDate;
      const ref = doc(db, 'participantsV4', uid, 'records', id);
      if (!demoMode) {
        const existing = await getDoc(ref);
        if (existing.exists()) { msg('今日の作戦は記録済みです。'); setFlow(null); await loadAll(); return; }
      }
      const savedExcuses = profile.customExcuses || [];
      const pastIntentions = records.map(r => r.dailyIntentionText);
      const pastSteps = records.map(r => r.firstStepText);
      const dailyIntentionSource = pastIntentions.includes(intention) ? 'history' : INTENTION_PRESETS.includes(intention) ? 'preset' : 'custom';
      const excuseSource = savedExcuses.includes(excuse) ? 'saved' : EXCUSES.includes(excuse) ? 'preset' : 'custom';
      const stepSource = pastSteps.includes(step) ? 'history' : STEPS.includes(step) ? 'preset' : 'custom';
      const sec = Math.floor((now.getTime() - sessionStart.current.getTime()) / 1000);
      const sessionDurationSeconds = Number.isInteger(sec) && sec >= 0 && sec < 86400 ? sec : null;
      const availMs = Math.max(getNextLifeDayStart(now).getTime(), now.getTime() + 6 * HOUR_MS);
      const d = {
        ownerUid: uid,
        participantCode: code,
        appVersion: APP_VERSION,
        recordDate: lifeDate,
        lifeDayStart: Timestamp.fromDate(getLifeDayStart(now)),
        dailyIntentionText: intention,
        dailyIntentionSource,
        predictedExcuse: excuse,
        excuseSource,
        firstStepText: step,
        stepSource,
        outcomeStatus: null,
        predictionMatched: null,
        actualExcuse: null,
        actualExcuseSource: null,
        selfBlameAfterNotStarted: null,
        sessionStartedAt: Timestamp.fromDate(sessionStart.current),
        planStartedAt: Timestamp.fromDate(v.planStartedAt),
        planCompletedAt: serverTimestamp(),
        sessionDurationSeconds,
        reviewAvailableAt: Timestamp.fromDate(new Date(availMs)),
        reviewStartedAt: null,
        reviewCompletedAt: null,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp()
      };
      await setDoc(ref, d);
      const updates = { appVersion: APP_VERSION };
      if (excuseSource === 'custom') updates.customExcuses = uniq([...savedExcuses, excuse]).slice(-20);
      updates.savedFirstSteps = uniq([step, ...(profile.savedFirstSteps || [])]).slice(0, 20);
      await updateDoc(doc(db, 'participantsV4', uid), { ...updates, updatedAt: serverTimestamp() });
      setProfile(p => ({ ...p, ...updates }));
      logEvent('plan_completed', { recordId: id });
      await loadAll();
      setShareDraft({ recordId: id, intention, excuse, step });
      setFlow('publish');
      msg('今日の作戦を記録しました。');
    } catch (e) {
      logError('write', 'savePlan', e);
      msg('記録できませんでした。');
    } finally {
      setSaving(false);
    }
  }

  async function publishExcuse(share) {
    try {
      if (share && shareDraft) {
        const ref = await addDoc(collection(db, 'publicPostsV4'), {
          ownerUid: uid,
          participantCode: code,
          dailyIntentionText: shareDraft.intention,
          goalText: shareDraft.intention,
          excuseText: shareDraft.excuse,
          firstStepText: shareDraft.step,
          isVisible: true,
          appVersion: APP_VERSION,
          createdAt: serverTimestamp(),
          hiddenAt: null
        });
        logEvent('post_shared', { recordId: shareDraft.recordId, postId: ref.id });
        msg('匿名で共有しました。');
      }
    } catch (e) {
      logError('share', 'publishExcuse', e);
      msg('共有できませんでした。');
    }
    setShareDraft(null); setFlow(null); setTab('home');
  }

  async function openReview() {
    if (!pending || pendingLocked) return;
    setFlow('review');
    reviewOpenedAt.current = new Date();
    reviewStartSaved.current = !!pending.reviewStartedAt;
    logEvent('review_opened', { recordId: pending.id });
    if (!pending.reviewStartedAt) {
      try {
        await updateDoc(doc(db, 'participantsV4', uid, 'records', pending.id), { reviewStartedAt: serverTimestamp(), updatedAt: serverTimestamp() });
        reviewStartSaved.current = true;
      } catch (e) {
        logError('write', 'reviewStart', e);
      }
    }
  }

  async function saveReview(v) {
    if (saving || !pending) return;
    const outcome = normalizeOutcome(v.outcomeStatus);
    if (!outcome || !['done', 'partial', 'not_started'].includes(v.outcomeStatus)) return;
    setSaving(true);
    try {
      const blame = outcome === 'not_started' && Number.isInteger(v.selfBlameAfterNotStarted) && v.selfBlameAfterNotStarted >= 1 && v.selfBlameAfterNotStarted <= 5 ? v.selfBlameAfterNotStarted : null;
      const saved = profile.customExcuses || [];
      const actual = v.predictionMatched === 'no' ? (v.actualExcuse || '').trim() : null;
      const actualExcuseSource = actual ? (saved.includes(actual) ? 'saved' : EXCUSES.includes(actual) ? 'preset' : 'custom') : null;
      const data = {
        outcomeStatus: outcome,
        predictionMatched: outcome === 'done' ? null : v.predictionMatched || null,
        actualExcuse: actual || null,
        actualExcuseSource,
        selfBlameAfterNotStarted: blame,
        reviewCompletedAt: serverTimestamp(),
        reviewedAt: serverTimestamp(),
        updatedAt: serverTimestamp()
      };
      if (!reviewStartSaved.current && reviewOpenedAt.current) data.reviewStartedAt = Timestamp.fromDate(reviewOpenedAt.current);
      await updateDoc(doc(db, 'participantsV4', uid, 'records', pending.id), data);
      if (v.addActualToLibrary && actual) {
        const xs = uniq([...saved, actual]).slice(-20);
        await updateDoc(doc(db, 'participantsV4', uid), { customExcuses: xs, updatedAt: serverTimestamp() });
        setProfile(p => ({ ...p, customExcuses: xs }));
      }
      logEvent('review_completed', { recordId: pending.id });
      await loadAll(); setFlow(null); setTab('home'); msg('振り返りを記録しました。');
    } catch (e) {
      logError('write', 'saveReview', e);
      msg('記録できませんでした。');
    } finally {
      setSaving(false);
    }
  }

  async function loadCommunity() {
    try {
      const snap = await getDocs(query(collection(db, 'publicPostsV4'), where('isVisible', '==', true), limit(50)));
      const all = snap.docs.map(x => ({ id: x.id, ...x.data() }));
      await Promise.all(all.map(async p => {
        const reactions = await getDocs(collection(db, 'publicPostsV4', p.id, 'reactions'));
        const counts = { wakaru: 0, sankou: 0, dekisou: 0 };
        let myReaction = null;
        reactions.docs.forEach(x => {
          const d = x.data();
          const type = normalizeReactionType(d.type); // 旧seedはdekisouとして扱う
          if (type && counts[type] !== undefined) counts[type]++;
          if ((x.id === uid || d.ownerUid === uid) && type && counts[type] !== undefined) myReaction = type;
        });
        p.counts = counts;
        p.myReaction = myReaction;
      }));
      setPosts(all.sort((a, b) => (b.createdAt?.seconds || 0) - (a.createdAt?.seconds || 0)));
      logEvent('community_view', { once: true });
    } catch (e) {
      logError('read', 'loadCommunity', e);
      msg('読み込めませんでした。');
    }
  }

  useEffect(() => { if (tab === 'community' && uid && code) loadCommunity() }, [tab, uid, code]);

  async function react(post, reactionId) {
    if (!uid) { msg('認証が確認できませんでした。'); return; }
    if (!REACTIONS.some(r => r.id === reactionId)) return;

    const prevMyReaction = post.myReaction;
    const prevCounts = { ...(post.counts || { wakaru: 0, sankou: 0, dekisou: 0 }) };
    const isSame = prevMyReaction === reactionId;
    const nextMyReaction = isSame ? null : reactionId;
    const nextCounts = { ...prevCounts };
    if (prevMyReaction && nextCounts[prevMyReaction] !== undefined) nextCounts[prevMyReaction] = Math.max(0, (nextCounts[prevMyReaction] || 0) - 1);
    if (!isSame && nextCounts[reactionId] !== undefined) nextCounts[reactionId] = (nextCounts[reactionId] || 0) + 1;

    // 楽観的UI更新
    setPosts(list => list.map(p => p.id === post.id ? { ...p, counts: nextCounts, myReaction: nextMyReaction } : p));

    const ref = doc(db, 'publicPostsV4', post.id, 'reactions', uid);
    try {
      if (isSame) {
        await deleteDoc(ref);
      } else {
        const data = { ownerUid: uid, type: reactionId, updatedAt: serverTimestamp() };
        if (!prevMyReaction) data.createdAt = serverTimestamp();
        await setDoc(ref, data, { merge: true });
      }
      logEvent(isSame ? 'reaction_removed' : prevMyReaction ? 'reaction_changed' : 'reaction_added', { postId: post.id, reactionType: reactionId });
    } catch (err) {
      console.error('Reaction error:', err.code, err.message);
      logError('reaction', 'react', err);
      setPosts(list => list.map(p => p.id === post.id ? { ...p, counts: prevCounts, myReaction: prevMyReaction } : p));
      msg('リアクションを保存できませんでした。');
    }
  }

  async function hidePost(post) {
    if (post.ownerUid !== uid) return;
    try {
      await updateDoc(doc(db, 'publicPostsV4', post.id), { isVisible: false, hiddenAt: serverTimestamp() });
      logEvent('post_hidden', { postId: post.id });
      await loadCommunity();
    } catch (e) {
      logError('write', 'hidePost', e);
      msg('取り消せませんでした。');
    }
  }

  const shell = (children, extra = {}) => <Shell demoMode={demoMode} toggleDemo={toggleDemo} {...extra}>{children}</Shell>;

  if (!firebaseReady) return shell(<Card><h1>Firebase設定を確認してください</h1></Card>);
  if (authFailed) return shell(<Card><h1>接続できませんでした</h1><p className="muted">時間をおいて再読み込みしてください。</p></Card>);
  if (!ready) return shell(<Loading />);
  if (!code) return shell(<Entry value={codeIn} setValue={setCodeIn} enter={enter} />);
  if (loading) return shell(<Loading />);
  if (!profile) return shell(<Onboard submit={onboard} />);
  if (flow === 'plan') return shell(<Plan profile={profile} records={records} save={savePlan} saving={saving} back={() => setFlow(null)} />);
  if (flow === 'publish' && shareDraft) return shell(<PublicExcuse draft={shareDraft} publish={publishExcuse} />);
  if (flow === 'review' && pending && !pendingLocked) return shell(<Review item={pending} profile={profile} save={saveReview} saving={saving} back={() => setFlow(null)} />);
  return (
    <Shell demoMode={demoMode} toggleDemo={toggleDemo} profile={profile} toast={toast}>
      <div className="page">
        {tab === 'home' && <Home pending={pending} pendingLocked={pendingLocked} current={current} planBlocked={planBlocked} records={records} review={openReview} plan={openPlan} />}
        {tab === 'excuses' && <MyRecords records={records} profile={profile} />}
        {tab === 'community' && <Community posts={posts} uid={uid} react={react} hidePost={hidePost} />}
      </div>
      <Nav tab={tab} setTab={setTab} />
    </Shell>
  );
}

function Shell({ children, demoMode, toggleDemo, toast }) {
  return (
    <div className="shell">
      <header>
        <b>みんだめ</b>
        <button type="button" className="demo-toggle" onClick={toggleDemo} title="デモモード切替">
          {demoMode ? <span className="demo-badge">DEMO</span> : <span className="demo-off">●</span>}
        </button>
      </header>
      <main>{children}</main>
      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}

function Card({ children, className = '' }) { return <section className={'card ' + className}>{children}</section> }
function Loading() { return <div className="center"><div className="loader" /><p>記録を確認しています</p></div> }

function Entry({ value, setValue, enter }) {
  return (
    <div className="entry">
      <p className="eyebrow">言い訳と最初の一歩</p>
      <h1>みんだめ</h1>
      <label>参加番号<input value={value} onChange={e => setValue(e.target.value)} placeholder="例：MD-001" /></label>
      <button className="primary" onClick={enter}>はじめる</button>
      <small>本名や学籍番号は入力しないでください。</small>
    </div>
  );
}

function Onboard({ submit }) {
  const [xs, setXs] = useState([]);
  const [extra, setExtra] = useState('');
  const [ok, setOk] = useState(false);
  const toggle = x => setXs(a => a.includes(x) ? a.filter(v => v !== x) : a.length < 3 ? [...a, x] : a);
  const add = () => { const x = extra.trim().slice(0, LIMITS.excuse); if (x && xs.length < 3 && !xs.includes(x)) { setXs(a => [...a, x]); setExtra('') } };
  return (
    <div className="stack">
      <h1>最初の設定</h1>
      <Card>
        <p>毎日、その日に少し整えたいことを1つ決めます。同じことでも別のことでもかまいません。</p>
      </Card>
      <Card>
        <label className="check">
          <input type="checkbox" checked={ok} onChange={e => setOk(e.target.checked)} />
          操作記録を研究データとして利用する説明を読み、同意します
        </label>
      </Card>
      <Card>
        <div className="count-head">
          <h2>よく使いそうな言い訳（1〜3個）</h2>
          <b>{xs.length}/3</b>
        </div>
        <p className="muted">候補から選んでも自分で書いてもかまいません。</p>
        <div className="chips">
          {EXCUSES.map(x => (
            <button key={x} type="button" className={xs.includes(x) ? 'chip on' : 'chip'} disabled={!xs.includes(x) && xs.length >= 3} onClick={() => toggle(x)}>{x}</button>
          ))}
        </div>
        <div className="add-row">
          <input value={extra} onChange={e => setExtra(e.target.value)} placeholder="自分の言い訳を書く" maxLength={LIMITS.excuse} />
          <button type="button" className="secondary" disabled={!extra.trim() || xs.length >= 3} onClick={add}>追加</button>
        </div>
        {xs.length > 0 && (
          <div className="selected-list">
            {xs.map(x => <button key={x} type="button" onClick={() => setXs(a => a.filter(v => v !== x))}>{x}<span>×</span></button>)}
          </div>
        )}
      </Card>
      <button className="primary" disabled={!ok || xs.length < 1 || xs.length > 3} onClick={() => submit({ excuses: xs })}>設定を保存</button>
    </div>
  );
}

function TripleCard({ intention, excuse, step }) {
  return (
    <>
      <p className="pair"><span>少し整えたいこと</span><b>{intention}</b></p>
      <p className="pair"><span>できなさそうな理由</span><b>{excuse}</b></p>
      <p className="pair"><span>それでもできそうな一歩</span><b>{step}</b></p>
      <p className="plan-sentence">「{excuse}」と思う日でも、<br /><strong>{step}</strong>ならできるかも。</p>
    </>
  );
}

function Home({ pending, pendingLocked, current, planBlocked, records, review, plan }) {
  const stats = useMemo(() => {
    let moved = 0, match = 0, other = 0;
    records.forEach(r => {
      const o = normalizeOutcome(r.outcomeStatus);
      if (o === 'done' || o === 'partial') moved++;
      else if (o === 'not_started' && r.predictionMatched === 'yes') match++;
      else if (o === 'not_started' && r.predictionMatched === 'no') other++;
    });
    return { moved, match, other, total: moved + match + other };
  }, [records]);
  return (
    <div className="stack">
      <div>
        <p className="eyebrow">ホーム</p>
        <h1>今日の記録</h1>
      </div>
      <Card className={pending && !pendingLocked ? 'attention' : ''}>
        <h2>振り返り</h2>
        {pending ? (
          <>
            <p className="pair"><span>整えたいこと</span><b>{intentionOf(pending)}</b></p>
            <p className="pair"><span>決めた一歩</span><b>{pending.firstStepText}</b></p>
            {pendingLocked
              ? <p className="muted">振り返りは翌朝4:00からできます。</p>
              : <button className="primary" onClick={review}>振り返る</button>}
          </>
        ) : (
          <p className="muted">振り返る記録はありません。</p>
        )}
      </Card>
      <Card>
        <h2>今日の作戦</h2>
        {current ? (
          <>
            <TripleCard intention={intentionOf(current)} excuse={current.predictedExcuse} step={current.firstStepText} />
            <span className="done">記録済み</span>
          </>
        ) : (
          <p>今日少し整えたいこと、できなさそうな理由、それでもできそうな一歩を決めます。</p>
        )}
        <button className="primary" disabled={planBlocked} onClick={plan}>{planBlocked ? '今日の作戦は登録済みです' : '今日の作戦を考える'}</button>
      </Card>
      <Pattern stats={stats} />
    </div>
  );
}

function Pattern({ stats }) {
  if (!stats.total) return <Card><h2>最近の予測と実際</h2><p className="muted">記録が増えると、ここに内訳が表示されます。</p></Card>;
  return (
    <Card>
      <h2>最近の予測と実際</h2>
      <div className="bar">
        <i className="moved" style={{ width: `${stats.moved / stats.total * 100}%` }} />
        <i className="match" style={{ width: `${stats.match / stats.total * 100}%` }} />
        <i className="other" style={{ width: `${stats.other / stats.total * 100}%` }} />
      </div>
      <div className="legend">
        <span><i className="dot moved" />できた <b>{stats.moved}</b></span>
        <span><i className="dot match" />予測どおり <b>{stats.match}</b></span>
        <span><i className="dot other" />別の理由 <b>{stats.other}</b></span>
      </div>
    </Card>
  );
}

function ChipPick({ title, hint, items, value, setValue, maxLength, placeholder }) {
  return (
    <Card>
      <h2>{title}</h2>
      {hint && <p className="muted">{hint}</p>}
      <div className="chips">
        {items.map(x => <button key={x} type="button" className={value === x ? 'chip on' : 'chip'} onClick={() => setValue(x)}>{x}</button>)}
      </div>
      <label>
        自分で書く
        <input value={value} onChange={e => setValue(e.target.value)} maxLength={maxLength} placeholder={placeholder} />
      </label>
    </Card>
  );
}

function Plan({ profile, records, save, saving, back }) {
  const [planStartedAt] = useState(() => new Date());
  const [intention, setIntention] = useState('');
  const [excuse, setExcuse] = useState('');
  const [step, setStep] = useState('');
  const pastIntentions = uniq(records.map(r => r.dailyIntentionText)).slice(0, 5);
  const pastSteps = uniq(records.map(r => r.firstStepText)).slice(0, 3);
  const intentionItems = uniq([...pastIntentions, ...INTENTION_PRESETS]);
  const excuseItems = uniq([...(profile.customExcuses || []), ...EXCUSES]);
  const stepItems = uniq([...pastSteps, ...STEPS]);
  const i = intention.trim(), e = excuse.trim(), s = step.trim();
  const valid = i && i.length <= LIMITS.intention && e && e.length <= LIMITS.excuse && s && s.length <= LIMITS.step;
  return (
    <div className="stack">
      <button className="back" onClick={back}>← ホームへ</button>
      <h1>今日の作戦</h1>
      <ChipPick
        title="今日、生活の中で、少し整えたいと思うことは？"
        hint="今日一日の中で、着手できたかを確認できることを書いてください。"
        items={intentionItems} value={intention} setValue={setIntention}
        maxLength={LIMITS.intention} placeholder="例：机の上を片付けたい"
      />
      <ChipPick
        title="今日、それができなさそうなのはなぜ？"
        items={excuseItems} value={excuse} setValue={setExcuse}
        maxLength={LIMITS.excuse} placeholder="例：時間がない"
      />
      <ChipPick
        title="その理由があっても、何ならできそう？"
        hint="できたかどうかが分かる、小さな動作にしてください。"
        items={stepItems} value={step} setValue={setStep}
        maxLength={LIMITS.step} placeholder="例：ゴミを1つ捨てる"
      />
      {valid && (
        <Card>
          <h2>確認</h2>
          <TripleCard intention={i} excuse={e} step={s} />
        </Card>
      )}
      <button className="primary" disabled={!valid || saving} onClick={() => save({ intention, excuse, step, planStartedAt })}>記録する</button>
    </div>
  );
}

function PublicExcuse({ draft, publish }) {
  return (
    <div className="stack">
      <p className="eyebrow">記録しました</p>
      <h1>今日の作戦</h1>
      <Card>
        <TripleCard intention={draft.intention} excuse={draft.excuse} step={draft.step} />
      </Card>
      <Card>
        <h2>匿名で共有する？（任意）</h2>
        <p className="muted">参加者に匿名で表示されます。個人が分かる内容が含まれていないか確認してください。</p>
      </Card>
      <button className="primary" onClick={() => publish(true)}>匿名で共有する</button>
      <button className="secondary" onClick={() => publish(false)}>共有しない</button>
    </div>
  );
}

function Review({ item, profile, save, saving, back }) {
  const [status, setStatus] = useState('');
  const [match, setMatch] = useState('');
  const [actual, setActual] = useState('');
  const [addActual, setAddActual] = useState(true);
  const [blame, setBlame] = useState(null);
  const actualOptions = uniq([...(profile.customExcuses || []), ...EXCUSES]);
  const asked = status === 'partial' || status === 'not_started';
  const canSave = status && (
    status === 'done' ||
    (match && (match !== 'no' || actual.trim()) && (status !== 'not_started' || blame !== null))
  );
  const choose = v => { setStatus(v); setMatch(''); setActual(''); setBlame(null); };
  return (
    <div className="stack">
      <button className="back" onClick={back}>← ホームへ</button>
      <h1>振り返り</h1>
      <Card>
        <p className="pair"><span>昨日の整えたいこと</span><b>{intentionOf(item)}</b></p>
        <p className="pair"><span>決めた一歩</span><b>{item.firstStepText}</b></p>
      </Card>
      <Card>
        <h2>前回決めた一歩は、どこまでできましたか？</h2>
        <div className="choices">
          <button type="button" className={status === 'done' ? 'choice on' : 'choice'} onClick={() => choose('done')}>完了した</button>
          <button type="button" className={status === 'partial' ? 'choice on' : 'choice'} onClick={() => choose('partial')}>途中まで行った</button>
          <button type="button" className={status === 'not_started' ? 'choice on' : 'choice'} onClick={() => choose('not_started')}>着手しなかった</button>
        </div>

      </Card>
      {asked && (
        <Card>
          <h2>できなかった理由に「{item.predictedExcuse}」は当てはまりましたか？</h2>
          <div className="choices">
            <button type="button" className={match === 'yes' ? 'choice on' : 'choice'} onClick={() => setMatch('yes')}>当てはまった</button>
            <button type="button" className={match === 'no' ? 'choice on' : 'choice'} onClick={() => setMatch('no')}>別の理由だった</button>
            <button type="button" className={match === 'unknown' ? 'choice on' : 'choice'} onClick={() => setMatch('unknown')}>よく分からない</button>
          </div>
          {match === 'no' && (
            <>
              <h3>実際には、どの理由が近かったですか？</h3>
              <div className="chips">
                {actualOptions.map(x => <button key={x} type="button" className={actual === x ? 'chip on' : 'chip'} onClick={() => setActual(x)}>{x}</button>)}
              </div>
              <label>ほかの理由<input value={actual} maxLength={LIMITS.excuse} onChange={e => setActual(e.target.value)} placeholder="例：時間がなかった" /></label>
              <label className="check">
                <input type="checkbox" checked={addActual} onChange={e => setAddActual(e.target.checked)} />
                この理由を言い訳集にも追加する
              </label>
            </>
          )}
        </Card>
      )}
      {status === 'not_started' && (
        <Card>
          <h2>今回できなかったことで、自分を責める気持ちはありますか？</h2>
          <p className="muted">1（全くない）〜 5（とてもある）でお答えください。</p>
          <div className="scale-buttons">
            {[1, 2, 3, 4, 5].map(n => (
              <button key={n} type="button" className={blame === n ? 'choice on' : 'choice'} onClick={() => setBlame(n)}>{n}</button>
            ))}
          </div>
          <div className="scale-labels">
            <small>1: 全くない</small>
            <small>5: とてもある</small>
          </div>
        </Card>
      )}
      <button
        className="primary"
        disabled={!canSave || saving}
        onClick={() => save({
          outcomeStatus: status,
          predictionMatched: asked ? match : null,
          actualExcuse: match === 'no' ? actual.trim() : null,
          selfBlameAfterNotStarted: status === 'not_started' ? blame : null,
          addActualToLibrary: match === 'no' && addActual
        })}
      >保存する</button>
    </div>
  );
}

function MyRecords({ records, profile }) {
  const [view, setView] = useState('reasons');
  return (
    <div className="stack">
      <div>
        <p className="eyebrow">自分の記録</p>
        <h1>{view === 'reasons' ? 'できなかった理由' : '踏み出せた一歩'}</h1>
      </div>
      <div className="record-switch">
        <button type="button" className={view === 'reasons' ? 'on' : ''} onClick={() => setView('reasons')}>できなかった理由</button>
        <button type="button" className={view === 'steps' ? 'on' : ''} onClick={() => setView('steps')}>踏み出せた一歩</button>
      </div>
      {view === 'reasons' ? <ReasonList records={records} profile={profile} /> : <StepList records={records} />}
    </div>
  );
}

function ReasonList({ records, profile }) {
  const data = useMemo(() => {
    const map = {};
    (profile.customExcuses || []).forEach(x => { if (x) map[x] = 0 });
    const add = x => { if (!x) return; map[x] = (map[x] || 0) + 1 };
    records.forEach(r => {
      if (normalizeOutcome(r.outcomeStatus) !== 'not_started') return;
      if (r.predictionMatched === 'yes') add(r.predictedExcuse);
      if (r.predictionMatched === 'no') add(r.actualExcuse);
    });
    return Object.entries(map).map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'ja'));
  }, [records, profile]);
  return (
    <>
      <p className="muted">実際にできなかった理由として記録された回数が多い順です。</p>
      {data.length === 0
        ? <Card><p className="muted">まだ登録された言い訳がありません。</p></Card>
        : data.map((x, i) => <Card key={x.name}><div className="rank"><b>{i + 1}</b><h2>{x.name}</h2><strong>{x.count}回</strong></div></Card>)
      }
    </>
  );
}

function StepList({ records }) {
  const data = useMemo(() => {
    const map = {};
    records.forEach((r, i) => {
      if (!r.firstStepText) return;
      const x = map[r.firstStepText] || { name: r.firstStepText, setCount: 0, doneCount: 0, continuedCount: 0, last: 0, excuses: {} };
      x.setCount++;
      x.last = Math.max(x.last, (tsToMs(r.createdAt) || 0) / 1000 || records.length - i);
      const o = normalizeOutcome(r.outcomeStatus);
      if (o === 'done' || o === 'partial') {
        x.doneCount++;
        if (r.continuedBeyondFirstStep) x.continuedCount++;
        if (r.predictedExcuse) x.excuses[r.predictedExcuse] = (x.excuses[r.predictedExcuse] || 0) + 1;
      }
      map[r.firstStepText] = x;
    });
    return Object.values(map)
      .map(x => ({ ...x, topExcuses: Object.entries(x.excuses).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'ja')).slice(0, 3) }))
      .sort((a, b) => b.doneCount - a.doneCount || b.continuedCount - a.continuedCount || b.last - a.last);
  }, [records]);
  return (
    <>
      <p className="muted">実際にできた回数が多い順です。どの言い訳の日に踏み出せたかも確認できます。</p>
      {data.length === 0
        ? <Card><p className="muted">まだ最初の一歩を設定した記録がありません。</p></Card>
        : data.map((x, i) => (
          <Card key={x.name}>
            <div className="rank"><b>{i + 1}</b><h2>{x.name}</h2><strong>{x.doneCount}回</strong></div>
            <div className="step-stats">
              <span>設定した <b>{x.setCount}</b></span>
              <span>できた <b>{x.doneCount}</b></span>
              {x.continuedCount > 0 && <span>その先も続いた <b>{x.continuedCount}</b></span>}
            </div>
            {x.topExcuses.length > 0 && (
              <div className="excuse-links">
                <small>この一歩ができた日の予測</small>
                {x.topExcuses.map(([name, count]) => <span key={name}>「{name}」 <b>{count}回</b></span>)}
              </div>
            )}
          </Card>
        ))
      }
    </>
  );
}

function Community({ posts, uid, react, hidePost }) {
  return (
    <div className="stack">
      <div>
        <p className="eyebrow">みんなの記録</p>
        <h1>予測と最初の一歩</h1>
        <p className="muted">みんなが共有した予測と最初の一歩です。</p>
      </div>
      {posts.length === 0
        ? <Card><p className="muted">まだ共有された記録がありません。</p></Card>
        : posts.map(p => <Post key={p.id} post={p} uid={uid} react={react} hidePost={hidePost} />)
      }
    </div>
  );
}

function Post({ post, uid, react, hidePost }) {
  const title = post.dailyIntentionText || post.goalText || '—';
  return (
    <Card className="post">
      <div className="post-head">
        <strong title={title}>{title}</strong>
        {post.ownerUid === uid && <small className="yours">あなたの記録</small>}
      </div>
      <div className="community-plan sentence">
        <p>「{post.excuseText}」と思う日でも、<br /><strong>{post.firstStepText || '最初の一歩は未登録'}</strong>ならできるかも。</p>
      </div>
      <div className="reacts">
        {REACTIONS.map(r => (
          <button
            key={r.id}
            type="button"
            aria-label={r.label}
            className={post.myReaction === r.id ? 'selected seed-button' : 'seed-button'}
            onClick={() => react(post, r.id)}
          >{r.icon} {r.label} <span>{(post.counts && post.counts[r.id]) || 0}</span></button>
        ))}
      </div>
      {post.ownerUid === uid && <button type="button" className="hide" onClick={() => hidePost(post)}>共有を取り消す</button>}
    </Card>
  );
}

function Nav({ tab, setTab }) {
  return (
    <nav>
      <button className={tab === 'home' ? 'on' : ''} onClick={() => setTab('home')}><span>⌂</span>ホーム</button>
      <button className={tab === 'excuses' ? 'on' : ''} onClick={() => setTab('excuses')}><span>▣</span>自分の記録</button>
      <button className={tab === 'community' ? 'on' : ''} onClick={() => setTab('community')}><span>◌</span>みんな</button>
    </nav>
  );
}
