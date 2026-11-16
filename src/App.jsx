import React, { useEffect, useMemo, useRef, useState } from 'react';
import { addDoc, collection, deleteDoc, deleteField, doc, getDoc, getDocs, limit, query, serverTimestamp, setDoc, Timestamp, updateDoc, where } from 'firebase/firestore';
import { db, firebaseReady, ensureAnonymousUser } from './firebase.js';

const APP_VERSION = '6.1.0';

const EXCUSES = [
  'どこから手をつけるか分からない',
  '眠い・だるい',
  '面倒くさい',
  '疲れた',
  '時間がない',
  'あとでやる',
  'スマホを見続けてしまう',
  '布団から出られない',
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

const MAX_CHOICES = 3;
const MAX_CANDIDATES = 5;

// 空文字・前後空白・完全重複を除去する
const cleanList = xs => {
  if (!Array.isArray(xs)) return [];
  const out = [];
  for (const x of xs) {
    if (typeof x !== 'string') continue;
    const t = x.trim();
    if (t && !out.includes(t)) out.push(t);
  }
  return out;
};
const listOf = cleanList;

// 初回設定で本人が登録した候補（preset）と、本人が過去に自由入力して保存した履歴（history）のみから最大5件を生成
// 共通プリセット一覧は含めず、重複表示しない
const buildCandidates = (preferred, history) => {
  const out = [];
  cleanList(preferred).forEach(t => {
    if (!out.some(o => o.text === t)) out.push({ text: t, source: 'preset' });
  });
  cleanList(history).forEach(t => {
    if (!out.some(o => o.text === t)) out.push({ text: t, source: 'history' });
  });
  return out.slice(0, MAX_CANDIDATES);
};
const needsPrefs = p => !p || listOf(p.preferredDailyIntentions).length === 0 || listOf(p.preferredExcuses).length === 0;

const REACTIONS = [
  { id: 'wakaru', label: 'わかる', icon: '🤲' },
  { id: 'sankou', label: '参考になる', icon: '💡' },
  { id: 'dekisou', label: 'できそう', icon: '👣' }
];

const LIMITS = { intention: 80, excuse: 60, step: 80, alternative: 500 };
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
// ---- 結果定義・旧データ互換・集計 ----
/**
 * type ActionResult =
 *   | "planned_method"
 *   | "not_started"
 *   | "alternative_method";
 * @typedef {"planned_method" | "not_started" | "alternative_method"} ActionResult
 */
const ACTION_RESULTS = [
  { value: 'planned_method', label: '最初に決めた方法で、取りかかることができた' },
  { value: 'not_started', label: '取りかかることができなかった' },
  { value: 'alternative_method', label: 'ほかの方法で、取りかかることができた' }
];
const VALID_ACTION_RESULTS = ACTION_RESULTS.map(x => x.value);

const ACTION_RESULT_SHORT_LABELS = {
  planned_method: '最初に決めた方法で取りかかれた',
  not_started: '取りかかれなかった',
  alternative_method: 'ほかの方法で取りかかれた'
};

// 新形式（actionResult）と旧形式（outcomeStatus: done/acted/partial/changed/not_started/not_done）の両方を安全に正規化する
const normalizeActionResult = rOrStatus => {
  const raw = rOrStatus && typeof rOrStatus === 'object'
    ? (rOrStatus.actionResult || rOrStatus.outcomeStatus)
    : rOrStatus;
  if (raw === 'planned_method' || raw === 'done' || raw === 'acted' || raw === 'partial') return 'planned_method';
  if (raw === 'alternative_method' || raw === 'changed') return 'alternative_method';
  if (raw === 'not_started' || raw === 'not_done') return 'not_started';
  return null; // unknown / null は未回答または主要集計対象外
};

// 旧コード互換エイリアス
const normalizeOutcome = normalizeActionResult;

const isStartedResult = rOrStatus => {
  const res = normalizeActionResult(rOrStatus);
  return res === 'planned_method' || res === 'alternative_method';
};

const getActionResultLabel = rOrStatus => {
  const res = normalizeActionResult(rOrStatus);
  return res ? ACTION_RESULT_SHORT_LABELS[res] : '振り返りなし';
};

// 集計処理：1. 3分類（当初方法による着手・未着手・代替方法による着手）、2. 着手の有無（着手あり・着手なし）
function summarizeRecords(records) {
  let plannedMethod = 0;
  let alternativeMethod = 0;
  let notStarted = 0;
  let matchedExcuse = 0;
  let otherExcuse = 0;
  (records || []).forEach(r => {
    const res = normalizeActionResult(r);
    if (res === 'planned_method') {
      plannedMethod++;
    } else if (res === 'alternative_method') {
      alternativeMethod++;
    } else if (res === 'not_started') {
      notStarted++;
      if (r.predictionMatched === 'yes') matchedExcuse++;
      else if (r.predictionMatched === 'no') otherExcuse++;
    }
  });
  const started = plannedMethod + alternativeMethod;
  const total = started + notStarted;
  return {
    byCategory: {
      planned_method: plannedMethod,
      not_started: notStarted,
      alternative_method: alternativeMethod
    },
    byStarted: {
      started,
      not_started: notStarted
    },
    plannedMethod,
    alternativeMethod,
    notStarted,
    started,
    matchedExcuse,
    otherExcuse,
    total
  };
}
const intentionOf = r => (r && (r.dailyIntentionText || r.goalText)) || '登録された行動';
const normalizeReactionType = t => (t === 'seed' ? 'dekisou' : t);

export default function App() {
  const sessionStart = useRef(new Date());
  const reviewOpenedAt = useRef(null);
  const reviewStartSaved = useRef(false);
  const savingRef = useRef(false);
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
  const [reviewTarget, setReviewTarget] = useState(null);
  const [shareDraft, setShareDraft] = useState(null);
  const [toast, setToast] = useState('');
  const [demoMode, setDemoMode] = useState(urlDemo);

  const msg = t => { setToast(t); setTimeout(() => setToast(''), 2200) };
  const toggleDemo = () => setDemoMode(v => !v);

  // エラーログ（個人情報・入力内容は保存しない。失敗しても再帰しない）
  async function logError(errorType, operation, err) {
    console.error(`App error [${errorType}:${operation}]:`, err?.code, err?.message, err);
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
      console.error('Error log failed:', e?.code, e?.message, e);
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
      const intentions = cleanList(v.intentions);
      const excuses = cleanList(v.excuses);
      const base = {
        ownerUid: uid,
        participantCode: code,
        customExcuses: excuses,
        preferredDailyIntentions: intentions,
        preferredExcuses: excuses,
        savedFirstSteps: [],
        appVersion: APP_VERSION
      };
      await setDoc(doc(db, 'participantsV4', uid), { ...base, consentedAt: serverTimestamp(), createdAt: serverTimestamp(), updatedAt: serverTimestamp() });
      setProfile(base);
    } catch (e) {
      logError('write', 'onboard', e);
      msg('保存できませんでした。');
    }
  }

  async function savePrefs(v) {
    try {
      const intentions = cleanList(v.intentions);
      const excuses = cleanList(v.excuses);
      const updates = {
        preferredDailyIntentions: intentions,
        preferredExcuses: excuses,
        customExcuses: cleanList([...cleanList(profile.customExcuses), ...excuses]).slice(0, 20),
        appVersion: APP_VERSION
      };
      await updateDoc(doc(db, 'participantsV4', uid), { ...updates, updatedAt: serverTimestamp() });
      setProfile(p => ({ ...p, ...updates }));
    } catch (e) {
      logError('write', 'savePrefs', e);
      msg('保存できませんでした。');
    }
  }

  const pending = records.find(r => !normalizeActionResult(r)) || null;
  const latestReviewed = records.find(r => !!normalizeActionResult(r)) || null;
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
    if (saving || savingRef.current) return;
    const intention = (v.intention || '').trim(), excuse = (v.excuse || '').trim(), step = (v.step || '').trim();
    if (!intention || intention.length > LIMITS.intention || !excuse || excuse.length > LIMITS.excuse || !step || step.length > LIMITS.step) return;
    savingRef.current = true;
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
      const okSource = s => (s === 'preset' || s === 'history' ? s : 'custom');
      const dailyIntentionSource = okSource(v.intentionSource);
      const excuseSource = okSource(v.excuseSource);
      const stepSource = okSource(v.stepSource);
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
      const updates = {
        appVersion: APP_VERSION,
        savedDailyIntentions: cleanList([intention, ...cleanList(profile.savedDailyIntentions)]).slice(0, 20),
        customExcuses: cleanList([excuse, ...cleanList(profile.customExcuses)]).slice(0, 20),
        savedFirstSteps: cleanList([step, ...cleanList(profile.savedFirstSteps)]).slice(0, 20)
      };
      await updateDoc(doc(db, 'participantsV4', uid), { ...updates, updatedAt: serverTimestamp() });
      setProfile(p => ({ ...p, ...updates }));
      logEvent('plan_completed', { recordId: id });
      await loadAll();
      setShareDraft({
        recordId: id,
        dailyIntentionText: intention,
        predictedExcuse: excuse,
        firstStepText: step
      });
      setFlow('publish');
      msg('今日の作戦を記録しました。');
    } catch (e) {
      logError('write', 'savePlan', e);
      msg('記録できませんでした。');
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }

  async function publishExcuse(share) {
    try {
      if (share && shareDraft) {
        const textIntention = (shareDraft.dailyIntentionText ?? shareDraft.intention ?? '').trim();
        const textExcuse = (shareDraft.predictedExcuse ?? shareDraft.excuse ?? '').trim();
        const textStep = (shareDraft.firstStepText ?? shareDraft.step ?? '').trim();
        const ref = await addDoc(collection(db, 'publicPostsV4'), {
          ownerUid: uid,
          participantCode: code,
          dailyIntentionText: textIntention,
          goalText: textIntention,
          predictedExcuse: textExcuse,
          excuseText: textExcuse,
          firstStepText: textStep,
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

  async function openReview(targetRecord = null) {
    const target = targetRecord && targetRecord.id ? targetRecord : pending;
    if (!target || !uid || (target.ownerUid && target.ownerUid !== uid)) return;
    const isUnreviewed = !normalizeActionResult(target);
    if (isUnreviewed && isReviewLocked(target, demoMode)) return;
    setReviewTarget(target);
    setFlow('review');
    reviewOpenedAt.current = new Date();
    reviewStartSaved.current = !!target.reviewStartedAt;
    logEvent('review_opened', { recordId: target.id });
    if (!target.reviewStartedAt) {
      try {
        const startPatch = {
          ownerUid: uid,
          reviewStartedAt: serverTimestamp(),
          updatedAt: serverTimestamp()
        };
        if ('actionResult' in target && target.actionResult == null) startPatch.actionResult = deleteField();
        if ('alternativeActionText' in target && target.alternativeActionText == null) startPatch.alternativeActionText = deleteField();
        await updateDoc(doc(db, 'participantsV4', uid, 'records', target.id), startPatch);
        reviewStartSaved.current = true;
      } catch (e) {
        logError('write', 'reviewStart', e);
      }
    }
  }

  async function saveReview(v) {
    const target = reviewTarget || pending;
    if (saving || savingRef.current || !target || !target.id) return false;
    if (!uid || (target.ownerUid && target.ownerUid !== uid)) {
      msg('記録を更新する権限がありません。');
      return false;
    }
    const actionResult = v.actionResult || v.outcomeStatus;
    if (!VALID_ACTION_RESULTS.includes(actionResult)) return false;
    const altText = actionResult === 'alternative_method' ? (v.alternativeActionText || '').trim() : '';
    if (actionResult === 'alternative_method' && (!altText || altText.length > LIMITS.alternative)) return false;
    if (actionResult === 'not_started') {
      if (!['yes', 'no', 'unknown'].includes(v.predictionMatched)) return false;
      if (v.predictionMatched === 'no' && !(v.actualExcuse || '').trim()) return false;
    }
    savingRef.current = true;
    setSaving(true);
    try {
      const saved = cleanList([...listOf(profile.preferredExcuses), ...listOf(profile.customExcuses)]);
      const actual = actionResult === 'not_started' && v.predictionMatched === 'no' ? (v.actualExcuse || '').trim() : null;
      const actualExcuseSource = actual ? (saved.includes(actual) ? 'saved' : EXCUSES.includes(actual) ? 'preset' : 'custom') : null;
      const data = {
        ownerUid: uid,
        actionResult,
        outcomeStatus: actionResult,
        alternativeActionText: actionResult === 'alternative_method' ? altText : deleteField(),
        predictionMatched: actionResult === 'not_started' ? (v.predictionMatched || null) : deleteField(),
        actualExcuse: actionResult === 'not_started' && actual ? actual : deleteField(),
        actualExcuseSource: actionResult === 'not_started' && actual ? actualExcuseSource : deleteField(),
        reviewCompletedAt: serverTimestamp(),
        reviewedAt: serverTimestamp(),
        updatedAt: serverTimestamp()
      };
      if (actionResult !== 'not_started') data.selfBlameAfterNotStarted = deleteField();
      if (!reviewStartSaved.current && reviewOpenedAt.current) data.reviewStartedAt = Timestamp.fromDate(reviewOpenedAt.current);

      await updateDoc(doc(db, 'participantsV4', uid, 'records', target.id), data);

      setRecords(prev => prev.map(r => {
        if (r.id !== target.id) return r;
        const next = {
          ...r,
          ownerUid: uid,
          actionResult,
          outcomeStatus: actionResult,
          reviewedAt: Timestamp.now(),
          updatedAt: Timestamp.now()
        };
        if (actionResult === 'alternative_method') next.alternativeActionText = altText;
        else delete next.alternativeActionText;
        if (actionResult === 'not_started') {
          next.predictionMatched = v.predictionMatched || null;
          if (actual) {
            next.actualExcuse = actual;
            next.actualExcuseSource = actualExcuseSource;
          } else {
            delete next.actualExcuse;
            delete next.actualExcuseSource;
          }
        } else {
          delete next.predictionMatched;
          delete next.actualExcuse;
          delete next.actualExcuseSource;
          delete next.selfBlameAfterNotStarted;
        }
        return next;
      }));

      if (actionResult === 'not_started' && v.addActualToLibrary && actual) {
        try {
          const xs = cleanList([actual, ...listOf(profile.customExcuses)]).slice(0, 20);
          await updateDoc(doc(db, 'participantsV4', uid), { customExcuses: xs, updatedAt: serverTimestamp() });
          setProfile(p => ({ ...p, customExcuses: xs }));
        } catch (e) {
          logError('write', 'addActualToLibrary', e);
        }
      }
      logEvent('review_completed', { recordId: target.id });
      await loadAll();
      setReviewTarget(null);
      setFlow(null);
      setTab('home');
      msg('振り返りを記録しました。');
      return true;
    } catch (e) {
      console.error('saveReview error:', e?.code, e?.message, e);
      logError('write', 'saveReview', e);
      msg('記録できませんでした。');
      return false;
    } finally {
      savingRef.current = false;
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

  const shell = (children, extra = {}) => <Shell demoMode={demoMode} toggleDemo={toggleDemo} toast={toast} {...extra}>{children}</Shell>;

  if (!firebaseReady) return shell(<Card><h1>Firebase設定を確認してください</h1></Card>);
  if (authFailed) return shell(<Card><h1>接続できませんでした</h1><p className="muted">時間をおいて再読み込みしてください。</p></Card>);
  if (!ready) return shell(<Loading />);
  if (!code) return shell(<Entry value={codeIn} setValue={setCodeIn} enter={enter} />);
  if (loading) return shell(<Loading />);
  if (!profile) return shell(<Onboard submit={onboard} />);
  if (needsPrefs(profile)) return shell(<PreferenceSetup profile={profile} submit={savePrefs} />);
  const activeReviewItem = reviewTarget
    ? (records.find(r => r.id === reviewTarget.id) || reviewTarget)
    : (pending && !pendingLocked ? pending : null);
  if (flow === 'plan') return shell(<Plan profile={profile} records={records} save={savePlan} saving={saving} back={() => setFlow(null)} />);
  if (flow === 'publish' && shareDraft) return shell(<PublicExcuse draft={shareDraft} publish={publishExcuse} />);
  if (flow === 'review' && activeReviewItem) return shell(<Review item={activeReviewItem} profile={profile} save={saveReview} saving={saving} back={() => { setReviewTarget(null); setFlow(null); }} />);
  return (
    <Shell demoMode={demoMode} toggleDemo={toggleDemo} profile={profile} toast={toast}>
      <div className="page">
        {tab === 'home' && <Home pending={pending} latestReviewed={latestReviewed} pendingLocked={pendingLocked} current={current} planBlocked={planBlocked} records={records} review={openReview} plan={openPlan} />}
        {tab === 'excuses' && <MyRecords records={records} profile={profile} editReview={openReview} />}
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
      <p className="eyebrow">言い訳と今日の対応</p>
      <h1>みんだめ</h1>
      <label>参加番号<input value={value} onChange={e => setValue(e.target.value)} placeholder="例：MD-001" /></label>
      <button className="primary" onClick={enter}>はじめる</button>
      <small>本名や学籍番号は入力しないでください。</small>
    </div>
  );
}

const between = a => a.length >= 1 && a.length <= MAX_CHOICES;

function MultiPick({ title, hint, presets, value, setValue, maxLength, placeholder }) {
  const [extra, setExtra] = useState('');
  const [notice, setNotice] = useState('');
  const full = value.length >= MAX_CHOICES;
  const tryAdd = x => {
    if (value.includes(x)) return true;
    if (full) { setNotice(`選べるのは${MAX_CHOICES}個までです。ほかを選ぶときは、選択中のものを外してください。`); return false; }
    setNotice('');
    setValue([...value, x]);
    return true;
  };
  const toggle = x => {
    if (value.includes(x)) { setNotice(''); setValue(value.filter(v => v !== x)); }
    else tryAdd(x);
  };
  const add = () => {
    const x = extra.trim().slice(0, maxLength);
    if (!x) return;
    if (tryAdd(x)) setExtra('');
  };
  return (
    <Card>
      <div className="count-head">
        <h2>{title}</h2>
        <b>{value.length}/{MAX_CHOICES}</b>
      </div>
      {hint && <p className="muted">{hint}</p>}
      <div className="chips">
        {presets.map(x => (
          <button key={x} type="button" className={value.includes(x) ? 'chip on' : 'chip'} aria-pressed={value.includes(x)} onClick={() => toggle(x)}>{x}</button>
        ))}
      </div>
      <div className="add-row">
        <input value={extra} onChange={e => setExtra(e.target.value)} placeholder={placeholder} maxLength={maxLength} />
        <button type="button" className="secondary" disabled={!extra.trim()} onClick={add}>追加</button>
      </div>
      {notice && <p className="notice" role="status">{notice}</p>}
      {value.length > 0 && (
        <div className="selected-list">
          {value.map(x => <button key={x} type="button" onClick={() => toggle(x)}>{x}<span>×</span></button>)}
        </div>
      )}
    </Card>
  );
}

function PreferencePickers({ intentions, setIntentions, excuses, setExcuses }) {
  return (
    <>
      <MultiPick
        title="よく整えたいと思うこと（1〜3個）"
        hint="毎日の質問で、ここで選んだものが候補として表示されます。自分で書いて追加することもできます。"
        presets={INTENTION_PRESETS} value={intentions} setValue={setIntentions}
        maxLength={LIMITS.intention} placeholder="自分で書く（例：机の上を片付けたい）"
      />
      <MultiPick
        title="よくある「できなさそうな理由」（1〜3個）"
        hint="候補から選んでも、自分で書いてもかまいません。"
        presets={EXCUSES} value={excuses} setValue={setExcuses}
        maxLength={LIMITS.excuse} placeholder="自分で書く（例：時間がない）"
      />
    </>
  );
}

function Onboard({ submit }) {
  const [ok, setOk] = useState(false);
  const [intentions, setIntentions] = useState([]);
  const [excuses, setExcuses] = useState([]);
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
      <PreferencePickers intentions={intentions} setIntentions={setIntentions} excuses={excuses} setExcuses={setExcuses} />
      <button className="primary" disabled={!ok || !between(intentions) || !between(excuses)} onClick={() => submit({ intentions, excuses })}>設定を保存</button>
    </div>
  );
}

// 既存利用者向け：preferredDailyIntentions / preferredExcuses が未設定のときだけ表示
function PreferenceSetup({ profile, submit }) {
  const [intentions, setIntentions] = useState(() => listOf(profile.preferredDailyIntentions).slice(0, MAX_CHOICES));
  const [excuses, setExcuses] = useState(() => {
    const pref = listOf(profile.preferredExcuses);
    return (pref.length ? pref : listOf(profile.customExcuses)).slice(0, MAX_CHOICES);
  });
  const [busy, setBusy] = useState(false);
  return (
    <div className="stack">
      <h1>追加の設定</h1>
      <Card>
        <p>毎日の質問で表示する候補を選びます。毎日、その日に少し整えたいことを1つ決めます。同じことでも別のことでもかまいません。</p>
      </Card>
      <PreferencePickers intentions={intentions} setIntentions={setIntentions} excuses={excuses} setExcuses={setExcuses} />
      <button
        className="primary"
        disabled={busy || !between(intentions) || !between(excuses)}
        onClick={async () => { setBusy(true); await submit({ intentions, excuses }); setBusy(false); }}
      >設定を保存</button>
    </div>
  );
}

function TripleCard({ intention, excuse, step }) {
  return (
    <>
      <p className="pair"><span>今日したいこと</span><b>{intention}</b></p>
      <p className="pair"><span>できなさそうな理由</span><b>{excuse}</b></p>
      <p className="pair"><span>最初に決めた方法</span><b>{step}</b></p>
      <p className="plan-sentence">「{excuse}」という言い訳がある今日は、<br /><strong>{step}</strong></p>
    </>
  );
}

function Home({ pending, latestReviewed, pendingLocked, current, planBlocked, records, review, plan }) {
  const stats = useMemo(() => summarizeRecords(records), [records]);
  const latestRes = latestReviewed ? normalizeActionResult(latestReviewed) : null;
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
            <p className="pair"><span>今日したいこと</span><b>{intentionOf(pending)}</b></p>
            <p className="pair"><span>最初に決めた方法</span><b>{pending.firstStepText}</b></p>
            {pendingLocked
              ? <p className="muted">振り返りは翌朝4:00からできます。</p>
              : <button className="primary" onClick={() => review()}>振り返る</button>}
          </>
        ) : latestReviewed ? (
          <>
            <div className="post-head">
              <strong>前回の振り返り</strong>
              <span className={`result-badge ${latestRes || ''}`}>{getActionResultLabel(latestReviewed)}</span>
            </div>
            <p className="pair"><span>今日したいこと</span><b>{intentionOf(latestReviewed)}</b></p>
            {latestRes === 'alternative_method' && latestReviewed.alternativeActionText && (
              <p className="pair"><span>ほかの方法</span><b>{latestReviewed.alternativeActionText}</b></p>
            )}
            <button type="button" className="secondary" onClick={() => review(latestReviewed)}>振り返りを編集する</button>
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
          <p>今日したいと思っていることと、できなさそうな理由（言い訳）を出し、今日はどうするかを考えます。</p>
        )}
        <button className="primary" disabled={planBlocked} onClick={plan}>{planBlocked ? '今日の作戦は登録済みです' : '今日の作戦を考える'}</button>
      </Card>
      <Pattern stats={stats} />
    </div>
  );
}

function Pattern({ stats }) {
  if (!stats.total) return <Card><h2>最近の振り返り内訳</h2><p className="muted">振り返りが増えると、ここに内訳が表示されます。</p></Card>;
  return (
    <Card>
      <h2>最近の振り返り内訳</h2>
      <div className="bar">
        <i className="moved" style={{ width: `${stats.plannedMethod / stats.total * 100}%` }} />
        <i className="alt" style={{ width: `${stats.alternativeMethod / stats.total * 100}%` }} />
        <i className="other" style={{ width: `${stats.notStarted / stats.total * 100}%` }} />
      </div>
      <div className="legend">
        <span><i className="dot moved" />最初に決めた方法で着手 <b>{stats.plannedMethod}</b></span>
        <span><i className="dot alt" />ほかの方法で着手 <b>{stats.alternativeMethod}</b></span>
        <span><i className="dot other" />未着手 <b>{stats.notStarted}</b></span>
      </div>
      <div className="step-stats two">
        <span>着手あり <b>{stats.started}</b></span>
        <span>未着手 <b>{stats.notStarted}</b></span>
      </div>
    </Card>
  );
}

const EMPTY_PICK = { text: '', pick: null };
// 候補をそのまま使えば候補の入力元、1文字でも編集したら custom
const pickSource = s => (s.pick && s.text.trim() === s.pick.text ? s.pick.source : 'custom');

function ChipPick({ id, title, hint, items, state, setState, maxLength, placeholder, example }) {
  const cur = state.text.trim();
  const list = items.slice(0, MAX_CANDIDATES);
  return (
    <Card>
      <h2><label htmlFor={id}>{title}</label></h2>
      {hint && <p id={`${id}-hint`} className="muted">{hint}</p>}
      <input
        id={id}
        value={state.text}
        onChange={e => { const v = e.target.value; setState(s => ({ ...s, text: v })); }}
        maxLength={maxLength}
        placeholder={list.length === 0 ? placeholder : '自分の言葉で入力'}
        aria-describedby={hint ? `${id}-hint` : undefined}
      />
      {list.length > 0 ? (
        <div className="ref-box">
          <small className="ref-title">参考にする</small>
          <div className="chips ref-chips">
            {list.map(x => (
              <button
                key={x.text}
                type="button"
                className={cur === x.text ? 'chip chip-sm on' : 'chip chip-sm'}
                aria-pressed={cur === x.text}
                onClick={() => setState({ text: x.text, pick: x })}
              >
                {x.text}
              </button>
            ))}
          </div>
        </div>
      ) : (
        example && <small className="muted example-hint">{example}</small>
      )}
    </Card>
  );
}

function Plan({ profile, records, save, saving, back }) {
  const [planStartedAt] = useState(() => new Date());
  const [intention, setIntention] = useState(EMPTY_PICK);
  const [excuse, setExcuse] = useState(EMPTY_PICK);
  const [step, setStep] = useState(EMPTY_PICK);
  const intentionItems = useMemo(
    () => buildCandidates(
      profile.preferredDailyIntentions,
      [...records.map(r => r.dailyIntentionText), ...listOf(profile.savedDailyIntentions)]
    ),
    [profile, records]
  );
  const excuseItems = useMemo(
    () => buildCandidates(
      profile.preferredExcuses,
      [...records.map(r => r.predictedExcuse), ...records.map(r => r.actualExcuse), ...listOf(profile.customExcuses)]
    ),
    [profile, records]
  );
  const stepItems = useMemo(() => {
    const usedSteps = cleanList(records.map(r => r.firstStepText));
    const customSaved = listOf(profile.savedFirstSteps).filter(s => !STEPS.includes(s) || usedSteps.includes(s));
    return buildCandidates(profile.preferredFirstSteps, [...usedSteps, ...customSaved]);
  }, [profile, records]);
  const i = intention.text.trim(), e = excuse.text.trim(), s = step.text.trim();
  const valid = i && i.length <= LIMITS.intention && e && e.length <= LIMITS.excuse && s && s.length <= LIMITS.step;
  return (
    <div className="stack">
      <button className="back" onClick={back}>← ホームへ</button>
      <h1>今日の作戦</h1>
      <p className="muted">候補を参考にしながら、自分の言葉で書いてください。</p>
      <ChipPick
        id="plan-intention"
        title="今日、したいと思っていることは？"
        hint="候補を参考にしながら、自分の言葉で書いてください。"
        items={intentionItems} state={intention} setState={setIntention}
        maxLength={LIMITS.intention} placeholder="例：机の上を片付けたい"
        example="入力例：机の上を片付けたい／洗濯物をしまいたい／風呂に入りたい"
      />
      <ChipPick
        id="plan-excuse"
        title="できなさそうな理由（言い訳）は？"
        hint="候補を参考にしながら、自分の言葉で書いてください。"
        items={excuseItems} state={excuse} setState={setExcuse}
        maxLength={LIMITS.excuse} placeholder="例：時間がない"
        example="入力例：どこから手をつけるか分からない／眠い・だるい／時間がない"
      />
      <ChipPick
        id="plan-method"
        title="その言い訳がある今日は、どうする？"
        hint="少しだけ試す、別のやり方にする、今日は休んで後日に回すなど、今日の状況に合った対応を自分の言葉で書いてください。"
        items={stepItems} state={step} setState={setStep}
        maxLength={LIMITS.step} placeholder="例：1つだけ片付ける／明日の朝に回す／今日は休む"
        example="入力例：ゴミを1つ捨てる／5分だけ試す／今日は休んで明日に回す"
      />
      {valid && (
        <Card>
          <h2>確認</h2>
          <TripleCard intention={i} excuse={e} step={s} />
        </Card>
      )}
      <button
        className="primary"
        disabled={!valid || saving}
        onClick={() => save({
          intention: i,
          excuse: e,
          step: s,
          intentionSource: pickSource(intention),
          excuseSource: pickSource(excuse),
          stepSource: pickSource(step),
          planStartedAt
        })}
      >記録する</button>
    </div>
  );
}

function PublicExcuse({ draft, publish }) {
  const intention = draft.dailyIntentionText || draft.intention || '';
  const excuse = draft.predictedExcuse || draft.excuse || '';
  const step = draft.firstStepText || draft.step || '';
  return (
    <div className="stack">
      <p className="eyebrow">記録しました</p>
      <h1>今日の作戦</h1>
      <Card>
        <TripleCard intention={intention} excuse={excuse} step={step} />
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
  const initialResult = normalizeActionResult(item) || '';
  const [actionResult, setActionResult] = useState(initialResult);
  const [alternativeText, setAlternativeText] = useState(
    initialResult === 'alternative_method' ? (item.alternativeActionText || '') : ''
  );
  const [match, setMatch] = useState(
    initialResult === 'not_started' ? (item.predictionMatched || '') : ''
  );
  const [actual, setActual] = useState(
    initialResult === 'not_started' && item.predictionMatched === 'no' ? (item.actualExcuse || '') : ''
  );
  const [addActual, setAddActual] = useState(true);
  const [error, setError] = useState('');
  const altRef = useRef(null);
  const actualRef = useRef(null);

  const actualOptions = useMemo(
    () => cleanList([...listOf(profile.preferredExcuses), ...listOf(profile.customExcuses)]).slice(0, MAX_CANDIDATES),
    [profile]
  );

  const choose = v => {
    setActionResult(v);
    setError('');
    if (v !== 'alternative_method') setAlternativeText('');
    if (v !== 'not_started') {
      setMatch('');
      setActual('');
    }
  };

  const handleSubmit = async e => {
    e.preventDefault();
    if (saving) return;
    if (!VALID_ACTION_RESULTS.includes(actionResult)) {
      setError('actionResult');
      return;
    }
    if (actionResult === 'alternative_method') {
      const trimmedAlt = alternativeText.trim();
      if (!trimmedAlt) {
        setError('alternative');
        if (altRef.current) altRef.current.focus();
        return;
      }
      if (trimmedAlt.length > LIMITS.alternative) {
        setError('alternativeLength');
        if (altRef.current) altRef.current.focus();
        return;
      }
    }
    if (actionResult === 'not_started') {
      if (!match) {
        setError('match');
        return;
      }
      if (match === 'no' && !actual.trim()) {
        setError('actual');
        if (actualRef.current) actualRef.current.focus();
        return;
      }
    }
    setError('');
    try {
      const payload = {
        actionResult,
        outcomeStatus: actionResult,
        predictionMatched: actionResult === 'not_started' ? match : null,
        actualExcuse: actionResult === 'not_started' && match === 'no' ? actual.trim() : null,
        addActualToLibrary: actionResult === 'not_started' && match === 'no' && addActual
      };
      if (actionResult === 'alternative_method') {
        payload.alternativeActionText = alternativeText.trim();
      }
      const ok = await save(payload);
      if (ok === false) setError('saveFailed');
    } catch (err) {
      console.error('Review submit error:', err?.code, err?.message, err);
      setError('saveFailed');
    }
  };

  return (
    <form className="stack" onSubmit={handleSubmit} noValidate>
      <button type="button" className="back" onClick={back}>← ホームへ</button>
      <h1>振り返り</h1>
      <Card>
        <p className="pair"><span>今日したいこと</span><b>{intentionOf(item)}</b></p>
        <p className="pair"><span>できなさそうな理由</span><b>{item.predictedExcuse}</b></p>
        <p className="pair"><span>最初に決めた方法</span><b>{item.firstStepText}</b></p>
      </Card>
      <Card>
        <h2 id="review-result-heading">今日したいと思っていたことについて、その後どうなりましたか？</h2>
        <div className="choices" role="radiogroup" aria-labelledby="review-result-heading">
          {ACTION_RESULTS.map(opt => {
            const selected = actionResult === opt.value;
            return (
              <label key={opt.value} className={selected ? 'choice radio-label on' : 'choice radio-label'}>
                <input
                  type="radio"
                  name="actionResult"
                  value={opt.value}
                  checked={selected}
                  onChange={() => choose(opt.value)}
                />
                <span>{opt.label}</span>
              </label>
            );
          })}
        </div>
        {error === 'actionResult' && (
          <p className="field-error" role="alert">当てはまるものを1つ選んでください。</p>
        )}
      </Card>
      {actionResult === 'alternative_method' && (
        <Card>
          <h2><label htmlFor="alternative-action-input">どのような方法で取りかかることができましたか？</label></h2>
          <p id="alternative-action-hint" className="muted">最初に考えていた方法との違いが分かるように、実際にできたことを書いてください。</p>
          <input
            id="alternative-action-input"
            ref={altRef}
            value={alternativeText}
            onChange={e => {
              setAlternativeText(e.target.value);
              if (error === 'alternative' || error === 'alternativeLength' || error === 'saveFailed') setError('');
            }}
            placeholder="例：全部片付ける代わりに、机の上のものだけ箱に入れた"
            aria-required="true"
            aria-invalid={error === 'alternative' || error === 'alternativeLength' || alternativeText.trim().length > LIMITS.alternative}
            aria-describedby={error === 'alternative' || error === 'alternativeLength' ? 'alternative-action-hint alternative-action-error' : 'alternative-action-hint'}
          />
          <small className="char-count" aria-live="polite">{alternativeText.trim().length} / {LIMITS.alternative}文字</small>
          {error === 'alternative' && (
            <p id="alternative-action-error" className="field-error" role="alert">実際にできた方法を入力してください。</p>
          )}
          {error === 'alternativeLength' && (
            <p id="alternative-action-error" className="field-error" role="alert">{LIMITS.alternative}文字以内で入力してください。</p>
          )}
        </Card>
      )}
      {actionResult === 'not_started' && (
        <Card>
          <h2 id="review-match-heading">予測した理由は、実際にも当てはまりましたか？</h2>
          <p className="muted">予測した理由：{item.predictedExcuse}</p>
          <div className="choices" role="radiogroup" aria-labelledby="review-match-heading">
            {[
              { value: 'yes', label: '当てはまった' },
              { value: 'no', label: '別の理由だった' },
              { value: 'unknown', label: 'よく分からない' }
            ].map(opt => {
              const selected = match === opt.value;
              return (
                <label key={opt.value} className={selected ? 'choice radio-label on' : 'choice radio-label'}>
                  <input
                    type="radio"
                    name="predictionMatched"
                    value={opt.value}
                    checked={selected}
                    onChange={() => {
                      setMatch(opt.value);
                      if (error === 'match' || error === 'actual') setError('');
                    }}
                  />
                  <span>{opt.label}</span>
                </label>
              );
            })}
          </div>
          {error === 'match' && (
            <p className="field-error" role="alert">当てはまるものを1つ選んでください。</p>
          )}
          {match === 'no' && (
            <>
              <label htmlFor="actual-excuse-input">
                実際の理由
                <input
                  id="actual-excuse-input"
                  ref={actualRef}
                  value={actual}
                  maxLength={LIMITS.excuse}
                  onChange={e => {
                    setActual(e.target.value);
                    if (error === 'actual') setError('');
                  }}
                  placeholder="例：時間がなかった"
                  aria-required="true"
                  aria-invalid={error === 'actual'}
                  aria-describedby={error === 'actual' ? 'actual-excuse-error' : undefined}
                />
              </label>
              {error === 'actual' && (
                <p id="actual-excuse-error" className="field-error" role="alert">実際の理由を入力してください。</p>
              )}
              {actualOptions.length > 0 && (
                <div className="ref-box">
                  <small className="ref-title">参考にする</small>
                  <div className="chips ref-chips">
                    {actualOptions.map(x => (
                      <button key={x} type="button" className={actual.trim() === x ? 'chip chip-sm on' : 'chip chip-sm'} onClick={() => { setActual(x); if (error === 'actual') setError(''); }}>{x}</button>
                    ))}
                  </div>
                </div>
              )}
              <label className="check">
                <input type="checkbox" checked={addActual} onChange={e => setAddActual(e.target.checked)} />
                この理由を言い訳集にも追加する
              </label>
            </>
          )}
        </Card>
      )}
      {error === 'saveFailed' && (
        <p className="field-error" role="alert">保存できませんでした。入力内容は残っていますので、通信状況を確認してもう一度お試しください。</p>
      )}
      <button type="submit" className="primary" disabled={saving}>{saving ? '保存しています...' : '保存する'}</button>
    </form>
  );
}

function MyRecords({ records, profile, editReview }) {
  const [view, setView] = useState('history');
  const titleMap = {
    history: '振り返り履歴',
    reasons: '未着手の理由',
    steps: 'できた方法'
  };
  return (
    <div className="stack">
      <div>
        <p className="eyebrow">自分の記録</p>
        <h1>{titleMap[view]}</h1>
      </div>
      <div className="record-switch three">
        <button type="button" className={view === 'history' ? 'on' : ''} onClick={() => setView('history')}>履歴</button>
        <button type="button" className={view === 'reasons' ? 'on' : ''} onClick={() => setView('reasons')}>理由</button>
        <button type="button" className={view === 'steps' ? 'on' : ''} onClick={() => setView('steps')}>できた方法</button>
      </div>
      {view === 'history' && <RecordHistoryList records={records} editReview={editReview} />}
      {view === 'reasons' && <ReasonList records={records} profile={profile} />}
      {view === 'steps' && <StepList records={records} />}
    </div>
  );
}

function RecordHistoryList({ records, editReview }) {
  if (records.length === 0) {
    return <Card><p className="muted">まだ記録がありません。</p></Card>;
  }
  return (
    <>
      <p className="muted">これまでの作戦と振り返りの結果を確認・編集できます。</p>
      {records.map(r => {
        const res = normalizeActionResult(r);
        return (
          <Card key={r.id}>
            <div className="post-head">
              <strong>{r.recordDate || '記録'}</strong>
              <span className={`result-badge ${res || ''}`}>{getActionResultLabel(r)}</span>
            </div>
            <p className="pair"><span>今日したいこと</span><b>{intentionOf(r)}</b></p>
            <p className="pair"><span>言い訳</span><b>{r.predictedExcuse || '—'}</b></p>
            <p className="pair"><span>最初に決めた方法</span><b>{r.firstStepText || '—'}</b></p>
            {res === 'alternative_method' && r.alternativeActionText && (
              <p className="pair"><span>ほかの方法</span><b>{r.alternativeActionText}</b></p>
            )}
            {res === 'not_started' && r.predictionMatched === 'no' && r.actualExcuse && (
              <p className="pair"><span>実際の理由</span><b>{r.actualExcuse}</b></p>
            )}
            {res && (
              <button type="button" className="secondary" onClick={() => editReview(r)}>振り返りを編集</button>
            )}
          </Card>
        );
      })}
    </>
  );
}

function ReasonList({ records, profile }) {
  const data = useMemo(() => {
    const map = {};
    (profile.customExcuses || []).forEach(x => { if (x) map[x] = 0 });
    const add = x => { if (!x) return; map[x] = (map[x] || 0) + 1 };
    records.forEach(r => {
      if (normalizeActionResult(r) !== 'not_started') return;
      if (r.predictionMatched === 'yes') add(r.predictedExcuse);
      if (r.predictionMatched === 'no') add(r.actualExcuse);
    });
    return Object.entries(map).map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'ja'));
  }, [records, profile]);
  return (
    <>
      <p className="muted">未着手だった日に記録された理由の回数です。</p>
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
      const x = map[r.firstStepText] || {
        name: r.firstStepText,
        setCount: 0,
        plannedCount: 0,
        altCount: 0,
        doneCount: 0,
        last: 0,
        excuses: {},
        altTexts: []
      };
      x.setCount++;
      x.last = Math.max(x.last, (tsToMs(r.createdAt) || 0) / 1000 || records.length - i);
      const res = normalizeActionResult(r);
      if (res === 'planned_method') {
        x.plannedCount++;
        x.doneCount++;
        if (r.predictedExcuse) x.excuses[r.predictedExcuse] = (x.excuses[r.predictedExcuse] || 0) + 1;
      } else if (res === 'alternative_method') {
        x.altCount++;
        x.doneCount++;
        if (r.alternativeActionText && !x.altTexts.includes(r.alternativeActionText)) {
          x.altTexts.push(r.alternativeActionText);
        }
        if (r.predictedExcuse) x.excuses[r.predictedExcuse] = (x.excuses[r.predictedExcuse] || 0) + 1;
      }
      map[r.firstStepText] = x;
    });
    return Object.values(map)
      .map(x => ({ ...x, topExcuses: Object.entries(x.excuses).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'ja')).slice(0, 3) }))
      .sort((a, b) => b.doneCount - a.doneCount || b.last - a.last);
  }, [records]);
  return (
    <>
      <p className="muted">最初に決めた方法と、ほかの方法で着手できた記録です。</p>
      {data.length === 0
        ? <Card><p className="muted">まだ記録がありません。</p></Card>
        : data.map((x, i) => (
          <Card key={x.name}>
            <div className="rank"><b>{i + 1}</b><h2>{x.name}</h2><strong>{x.doneCount}回</strong></div>
            <div className="step-stats">
              <span>設定した <b>{x.setCount}</b></span>
              <span>当初方法 <b>{x.plannedCount}</b></span>
              <span>ほかの方法 <b>{x.altCount}</b></span>
            </div>
            {x.altTexts.length > 0 && (
              <div className="excuse-links">
                <small>実際にできたほかの方法</small>
                {x.altTexts.slice(0, 5).map(t => <span key={t}>{t}</span>)}
              </div>
            )}
            {x.topExcuses.length > 0 && (
              <div className="excuse-links">
                <small>着手できた日の言い訳</small>
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
        <h1>みんなの言い訳と対応</h1>
        <p className="muted">みんなが共有した言い訳と今日の対応です。</p>
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
  const excuse = post.predictedExcuse || post.excuseText || '';
  return (
    <Card className="post">
      <div className="post-head">
        <strong title={title}>{title}</strong>
        {post.ownerUid === uid && <small className="yours">あなたの記録</small>}
      </div>
      <div className="community-plan sentence">
        <p>「{excuse}」という言い訳がある日：<br /><strong>{post.firstStepText || '対応は未登録'}</strong></p>
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
