import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import admin from 'firebase-admin';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const serviceAccountPath = path.join(__dirname, 'serviceAccountKey.json');
if (!fs.existsSync(serviceAccountPath)) {
  console.error('Error: serviceAccountKey.json が見つかりません。');
  process.exit(1);
}

const serviceAccount = JSON.parse(fs.readFileSync(serviceAccountPath, 'utf8'));

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();

// Timestamp型や日時文字列をJST (Asia/Tokyo) のISO風文字列に変換
function formatTimestamp(val) {
  if (!val) return '';
  let date;
  if (typeof val.toDate === 'function') {
    date = val.toDate();
  } else if (val._seconds !== undefined) {
    date = new Date(val._seconds * 1000);
  } else if (val.seconds !== undefined) {
    date = new Date(val.seconds * 1000);
  } else if (typeof val === 'string' || typeof val === 'number') {
    date = new Date(val);
  } else {
    return String(val);
  }
  if (isNaN(date.getTime())) return String(val);

  // JST (UTC+9) 変換
  const jstDate = new Date(date.getTime() + 9 * 60 * 60 * 1000);
  return jstDate.toISOString().replace('Z', '+09:00');
}

// CSV用の値エスケープ
function escapeCsv(val) {
  if (val === null || val === undefined) return '';
  const str = String(val);
  if (str.includes(',') || str.includes('\n') || str.includes('\r') || str.includes('"')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

async function exportRecords() {
  console.log('Fetching participantsV4 and records...');
  const participantsSnap = await db.collection('participantsV4').get();
  const rows = [];

  const headers = [
    'participantCode',
    'uid',
    'appVersion',
    'lifeDayStart',
    'predictedExcuse',
    'excuseSource',
    'firstStepText',
    'stepSource',
    'outcomeStatus',
    'predictionMatched',
    'actualExcuse',
    'selfBlameScore',
    'createdAt',
    'reviewedAt',
    'sessionStartedAt',
    'planStartedAt',
    'planCompletedAt',
    'reviewStartedAt',
    'reviewCompletedAt'
  ];

  for (const partDoc of participantsSnap.docs) {
    const uid = partDoc.id;
    const partData = partDoc.data();
    const recordsSnap = await partDoc.ref.collection('records').get();

    for (const recDoc of recordsSnap.docs) {
      const rec = recDoc.data();
      const row = {
        participantCode: rec.participantCode || partData.participantCode || '',
        uid: rec.ownerUid || uid,
        appVersion: rec.appVersion || partData.appVersion || '',
        lifeDayStart: rec.lifeDayStart || rec.recordDate || '',
        predictedExcuse: rec.predictedExcuse || '',
        excuseSource: rec.excuseSource || '',
        firstStepText: rec.firstStepText || '',
        stepSource: rec.stepSource || '',
        outcomeStatus: rec.outcomeStatus || '',
        predictionMatched: rec.predictionMatched || '',
        actualExcuse: rec.actualExcuse || '',
        selfBlameScore: rec.selfBlameScore !== undefined && rec.selfBlameScore !== null ? rec.selfBlameScore : '',
        createdAt: formatTimestamp(rec.createdAt),
        reviewedAt: formatTimestamp(rec.reviewedAt),
        sessionStartedAt: rec.sessionStartedAt ? formatTimestamp(rec.sessionStartedAt) : '',
        planStartedAt: rec.planStartedAt ? formatTimestamp(rec.planStartedAt) : '',
        planCompletedAt: formatTimestamp(rec.planCompletedAt),
        reviewStartedAt: rec.reviewStartedAt ? formatTimestamp(rec.reviewStartedAt) : '',
        reviewCompletedAt: formatTimestamp(rec.reviewCompletedAt)
      };
      rows.push(row);
    }
  }

  rows.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));

  const csvLines = [headers.join(',')];
  for (const r of rows) {
    csvLines.push(headers.map(h => escapeCsv(r[h])).join(','));
  }

  const csvContent = '\uFEFF' + csvLines.join('\r\n');
  const outputPath = path.join(__dirname, 'mindame_records.csv');
  fs.writeFileSync(outputPath, csvContent, 'utf8');
  console.log(`Saved ${rows.length} records to ${outputPath}`);
}

async function exportPosts() {
  console.log('Fetching publicPostsV4 and reactions...');
  const postsSnap = await db.collection('publicPostsV4').get();
  const rows = [];

  const headers = [
    'postId',
    'ownerUid',
    'goalText',
    'excuseText',
    'firstStepText',
    'isVisible',
    'createdAt',
    'reactionUid',
    'reactionType',
    'reactionUpdatedAt'
  ];

  for (const postDoc of postsSnap.docs) {
    const postId = postDoc.id;
    const post = postDoc.data();
    const reactionsSnap = await postDoc.ref.collection('reactions').get();

    if (reactionsSnap.empty) {
      rows.push({
        postId,
        ownerUid: post.ownerUid || '',
        goalText: post.goalText || '',
        excuseText: post.excuseText || '',
        firstStepText: post.firstStepText || '',
        isVisible: post.isVisible !== undefined ? post.isVisible : true,
        createdAt: formatTimestamp(post.createdAt),
        reactionUid: '',
        reactionType: '',
        reactionUpdatedAt: ''
      });
    } else {
      for (const reactDoc of reactionsSnap.docs) {
        const react = reactDoc.data();
        rows.push({
          postId,
          ownerUid: post.ownerUid || '',
          goalText: post.goalText || '',
          excuseText: post.excuseText || '',
          firstStepText: post.firstStepText || '',
          isVisible: post.isVisible !== undefined ? post.isVisible : true,
          createdAt: formatTimestamp(post.createdAt),
          reactionUid: reactDoc.id,
          reactionType: react.type || '',
          reactionUpdatedAt: formatTimestamp(react.updatedAt || react.createdAt)
        });
      }
    }
  }

  rows.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));

  const csvLines = [headers.join(',')];
  for (const r of rows) {
    csvLines.push(headers.map(h => escapeCsv(r[h])).join(','));
  }

  const csvContent = '\uFEFF' + csvLines.join('\r\n');
  const outputPath = path.join(__dirname, 'mindame_posts.csv');
  fs.writeFileSync(outputPath, csvContent, 'utf8');
  console.log(`Saved ${rows.length} post rows to ${outputPath}`);
}

async function main() {
  try {
    await exportRecords();
    await exportPosts();
    console.log('Export completed successfully!');
  } catch (err) {
    console.error('Export failed:', err);
    process.exit(1);
  }
}

main();
