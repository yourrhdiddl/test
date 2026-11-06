import { initializeApp } from 'firebase/app';
import {
  getAuth,
  GoogleAuthProvider,
  signInWithPopup,
  signOut,
  onAuthStateChanged
} from 'firebase/auth';
import {
  getFirestore,
  doc,
  getDoc,
  setDoc,
  updateDoc,
  deleteDoc,
  collection,
  onSnapshot,
  query,
  orderBy,
  getDocFromServer
} from 'firebase/firestore';

// 1. Load Firebase configuration
const configRes = await fetch('/firebase-applet-config.json');
const firebaseConfig = await configRes.json();

const app = initializeApp(firebaseConfig);
export const db = getFirestore(app, firebaseConfig.firestoreDatabaseId);
export const auth = getAuth(app);

// Google Auth Provider with Google Sheets scope
const SCOPES = ['https://www.googleapis.com/auth/spreadsheets'];
const googleProvider = new GoogleAuthProvider();
SCOPES.forEach(scope => googleProvider.addScope(scope));

// In-memory token cache (never stored in localStorage)
let cachedAccessToken = null;

// 2. Error handling conforming to skill specification
const OperationType = {
  CREATE: 'create',
  UPDATE: 'update',
  DELETE: 'delete',
  LIST: 'list',
  GET: 'get',
  WRITE: 'write',
};

function handleFirestoreError(error, operationType, path) {
  const errInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: auth.currentUser?.uid || null,
      email: auth.currentUser?.email || null,
      emailVerified: auth.currentUser?.emailVerified || null,
      isAnonymous: auth.currentUser?.isAnonymous || null,
      tenantId: auth.currentUser?.tenantId || null,
      providerInfo: auth.currentUser?.providerData?.map(provider => ({
        providerId: provider.providerId,
        email: provider.email,
      })) || []
    },
    operationType,
    path
  };
  console.error('Firestore Error: ', JSON.stringify(errInfo));
  throw new Error(JSON.stringify(errInfo));
}

// 3. Test Connection on boot
async function testConnection() {
  try {
    await getDocFromServer(doc(db, 'registrations', 'probe_connection_check'));
  } catch (error) {
    if (error instanceof Error && error.message.includes('the client is offline')) {
      console.error("Please check your Firebase configuration: client is offline.");
    }
  }
}
testConnection();

// State management
let currentUser = null;
let registrations = [];
let unsubscribeSnapshot = null;
let currentFilter = {
  search: '',
  status: 'all',
  job: 'all',
  sortBy: 'latest'
};
let pendingDeleteId = null;
let linkedSheet = null; // { spreadsheetId, spreadsheetUrl, spreadsheetTitle, lastSyncedAt }

// DOM Elements
const authRequiredBanner = document.getElementById('authRequiredBanner');
const organizerContent = document.getElementById('organizerContent');
const googleLoginBtn = document.getElementById('googleLoginBtn');
const googleLogoutBtn = document.getElementById('googleLogoutBtn');
const organizerEmailSpan = document.getElementById('organizerEmailSpan');
const liveSyncStatusBadge = document.getElementById('liveSyncStatusBadge');

// Google Sheets Section Elements
const sheetStatusChip = document.getElementById('sheetStatusChip');
const sheetTitleText = document.getElementById('sheetTitleText');
const sheetSyncTimeText = document.getElementById('sheetSyncTimeText');
const openSheetLinkBtn = document.getElementById('openSheetLinkBtn');
const createSheetBtn = document.getElementById('createSheetBtn');
const syncToSheetBtn = document.getElementById('syncToSheetBtn');
const linkExistingSheetBtn = document.getElementById('linkExistingSheetBtn');

// Stats Elements
const statTotal = document.getElementById('statTotal');
const statConfirmed = document.getElementById('statConfirmed');
const statPending = document.getElementById('statPending');
const statCancelled = document.getElementById('statCancelled');

// Table & Controls
const searchInput = document.getElementById('searchInput');
const statusFilterSelect = document.getElementById('statusFilterSelect');
const jobFilterSelect = document.getElementById('jobFilterSelect');
const sortBySelect = document.getElementById('sortBySelect');
const applicantsTableBody = document.getElementById('applicantsTableBody');
const emptyApplicantsState = document.getElementById('emptyApplicantsState');
const applicantCountLabel = document.getElementById('applicantCountLabel');

// Action Buttons
const copyEmailsBtn = document.getElementById('copyEmailsBtn');
const exportCsvBtn = document.getElementById('exportCsvBtn');
const generateSampleBtn = document.getElementById('generateSampleBtn');

// Modals
const deleteModal = document.getElementById('deleteModal');
const deleteModalName = document.getElementById('deleteModalName');
const cancelDeleteBtn = document.getElementById('cancelDeleteBtn');
const confirmDeleteBtn = document.getElementById('confirmDeleteBtn');

const detailModal = document.getElementById('detailModal');
const closeDetailModalBtn = document.getElementById('closeDetailModalBtn');
const detailContent = document.getElementById('detailContent');

const syncSheetModal = document.getElementById('syncSheetModal');
const syncModalCount = document.getElementById('syncModalCount');
const syncModalTargetSheet = document.getElementById('syncModalTargetSheet');
const cancelSyncSheetBtn = document.getElementById('cancelSyncSheetBtn');
const confirmSyncSheetBtn = document.getElementById('confirmSyncSheetBtn');

const linkSheetModal = document.getElementById('linkSheetModal');
const existingSheetInput = document.getElementById('existingSheetInput');
const cancelLinkSheetBtn = document.getElementById('cancelLinkSheetBtn');
const confirmLinkSheetBtn = document.getElementById('confirmLinkSheetBtn');

// Toast notification helper
function showToast(message, type = 'info') {
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.textContent = message;
  document.body.appendChild(toast);
  requestAnimationFrame(() => toast.classList.add('show'));
  setTimeout(() => {
    toast.classList.remove('show');
    setTimeout(() => toast.remove(), 320);
  }, 3400);
}

// Authentication state listener
onAuthStateChanged(auth, async (user) => {
  currentUser = user;
  if (user) {
    authRequiredBanner.hidden = true;
    organizerContent.hidden = false;
    organizerEmailSpan.textContent = user.email || '인증된 주최자';
    initOrganizerRealtime();
    await loadLinkedSheetMeta();
  } else {
    cachedAccessToken = null;
    organizerEmailSpan.textContent = '미인증';
    authRequiredBanner.hidden = false;
    organizerContent.hidden = true;
    if (unsubscribeSnapshot) {
      unsubscribeSnapshot();
      unsubscribeSnapshot = null;
    }
  }
});

// Google Sign In with Sheets scope
googleLoginBtn?.addEventListener('click', async () => {
  try {
    googleLoginBtn.disabled = true;
    googleLoginBtn.textContent = '로그인 중...';
    const result = await signInWithPopup(auth, googleProvider);
    const credential = GoogleAuthProvider.credentialFromResult(result);
    if (credential?.accessToken) {
      cachedAccessToken = credential.accessToken;
    }
    showToast('주최자 인증 및 구글 시트 권한 획득 성공!', 'success');
  } catch (err) {
    console.error('Login error:', err);
    showToast('로그인에 실패했습니다: ' + (err.message || '인증 취소'), 'error');
  } finally {
    googleLoginBtn.disabled = false;
    googleLoginBtn.textContent = 'Google 계정으로 주최자 로그인';
  }
});

// Google Logout
googleLogoutBtn?.addEventListener('click', async () => {
  try {
    await signOut(auth);
    cachedAccessToken = null;
    showToast('로그아웃되었습니다.', 'info');
  } catch (err) {
    console.error('Logout error:', err);
  }
});

// Helper to ensure OAuth access token is ready
async function ensureAccessToken() {
  if (cachedAccessToken) return cachedAccessToken;
  // If user is logged in, re-trigger popup to get fresh token with sheets scope
  try {
    const result = await signInWithPopup(auth, googleProvider);
    const credential = GoogleAuthProvider.credentialFromResult(result);
    if (credential?.accessToken) {
      cachedAccessToken = credential.accessToken;
      return cachedAccessToken;
    }
  } catch (err) {
    console.error('Failed to acquire token:', err);
    throw new Error('Google Sheets 접근 권한(OAuth 토큰) 획득 실패. 다시 로그인해주세요.');
  }
  throw new Error('Google OAuth 토큰을 찾을 수 없습니다.');
}

// Load Linked Sheet metadata from Firestore
async function loadLinkedSheetMeta() {
  try {
    const docRef = doc(db, 'settings', 'google_sheets');
    const snap = await getDoc(docRef);
    if (snap.exists()) {
      linkedSheet = snap.data();
      renderSheetStatusUI();
    } else {
      linkedSheet = null;
      renderSheetStatusUI();
    }
  } catch (err) {
    console.warn('Failed to load linked sheet settings:', err);
  }
}

// Render Google Sheets UI in toolbar
function renderSheetStatusUI() {
  if (linkedSheet && linkedSheet.spreadsheetId) {
    sheetStatusChip.textContent = '시트 연동됨';
    sheetStatusChip.className = 'status-badge status-live';
    sheetTitleText.textContent = linkedSheet.spreadsheetTitle || '2026 AI 웨비나 참가 신청자 명단';
    const syncTime = linkedSheet.lastSyncedAt
      ? new Date(linkedSheet.lastSyncedAt).toLocaleString('ko-KR')
      : '동기화 기록 없음';
    sheetSyncTimeText.textContent = `최근 동기화: ${syncTime}`;
    openSheetLinkBtn.hidden = false;
    openSheetLinkBtn.href = linkedSheet.spreadsheetUrl || `https://docs.google.com/spreadsheets/d/${linkedSheet.spreadsheetId}`;
    syncToSheetBtn.hidden = false;
  } else {
    sheetStatusChip.textContent = '시트 미연동';
    sheetStatusChip.className = 'status-badge status-syncing';
    sheetTitleText.textContent = '연동된 구글 시트가 없습니다';
    sheetSyncTimeText.textContent = '아래 버튼으로 새 시트를 만들거나 기존 시트를 연결하세요.';
    openSheetLinkBtn.hidden = true;
    syncToSheetBtn.hidden = true;
  }
}

// Create New Google Spreadsheet
createSheetBtn?.addEventListener('click', async () => {
  try {
    createSheetBtn.disabled = true;
    createSheetBtn.textContent = '시트 생성 중...';

    const token = await ensureAccessToken();
    const title = '2026 AI 웨비나 참가 신청자 명단';

    // 1. Create Spreadsheet via Google Sheets API v4
    const createRes = await fetch('https://sheets.googleapis.com/v4/spreadsheets', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        properties: {
          title: title
        },
        sheets: [
          {
            properties: {
              title: '신청자명단',
              gridProperties: {
                rowCount: Math.max(100, registrations.length + 20),
                columnCount: 10,
                frozenRowCount: 1
              }
            }
          }
        ]
      })
    });

    if (!createRes.ok) {
      const errData = await createRes.json();
      throw new Error(errData.error?.message || '구글 시트 생성 실패');
    }

    const createdSheet = await createRes.json();
    const spreadsheetId = createdSheet.spreadsheetId;
    const spreadsheetUrl = createdSheet.spreadsheetUrl || `https://docs.google.com/spreadsheets/d/${spreadsheetId}`;

    // 2. Populate Headers & Current Registrations
    await syncRegistrationsToSheetAPI(token, spreadsheetId, registrations);

    // 3. Save to Firestore
    const sheetData = {
      spreadsheetId,
      spreadsheetUrl,
      spreadsheetTitle: title,
      lastSyncedAt: new Date().toISOString()
    };
    await setDoc(doc(db, 'settings', 'google_sheets'), sheetData);
    linkedSheet = sheetData;
    renderSheetStatusUI();

    showToast('구글 스프레드시트가 성공적으로 생성 및 연동되었습니다!', 'success');
  } catch (err) {
    console.error('Create sheet error:', err);
    showToast('구글 시트 생성 오류: ' + (err.message || '권한 확인 필요'), 'error');
  } finally {
    createSheetBtn.disabled = false;
    createSheetBtn.innerHTML = `
      <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="12" y1="18" x2="12" y2="12"/><line x1="9" y1="15" x2="15" y2="15"/></svg>
      새 구글 시트 자동 생성
    `;
  }
});

// Sync Existing Registrations to Spreadsheet API
async function syncRegistrationsToSheetAPI(token, spreadsheetId, list) {
  const headers = ['접수번호', '신청일시', '이름', '이메일', '연락처', '직군/소속', '사전 질문 및 기대평', '참가 상태'];
  const rows = list.map(reg => {
    const d = new Date(reg.createdAt);
    const dateFormatted = !isNaN(d.getTime()) ? d.toLocaleString('ko-KR') : reg.createdAt;
    const statusText = reg.status === 'confirmed' ? '참가 확정' : reg.status === 'cancelled' ? '취소' : '대기 중';
    return [
      reg.id || '',
      dateFormatted,
      reg.name || '',
      reg.email || '',
      reg.phone || '-',
      reg.job || '-',
      reg.question || '-',
      statusText
    ];
  });

  const allValues = [headers, ...rows];

  // Overwrite range A1:H
  const range = `신청자명단!A1:H${allValues.length}`;
  const putRes = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(range)}?valueInputOption=USER_ENTERED`, {
    method: 'PUT',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      range,
      majorDimension: 'ROWS',
      values: allValues
    })
  });

  if (!putRes.ok) {
    // If sheet title "신청자명단" failed, try Sheet1!A1
    const fallbackRange = `A1:H${allValues.length}`;
    const fallbackRes = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(fallbackRange)}?valueInputOption=USER_ENTERED`, {
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        range: fallbackRange,
        majorDimension: 'ROWS',
        values: allValues
      })
    });
    if (!fallbackRes.ok) {
      const errData = await fallbackRes.json();
      throw new Error(errData.error?.message || '시트 데이터 동기화 실패');
    }
  }

  // Update lastSyncedAt in Firestore
  const updateData = {
    lastSyncedAt: new Date().toISOString()
  };
  await setDoc(doc(db, 'settings', 'google_sheets'), updateData, { merge: true });
  if (linkedSheet) linkedSheet.lastSyncedAt = updateData.lastSyncedAt;
  renderSheetStatusUI();
}

// Sync All Registrations button -> opens confirmation modal (User Confirmation for Destructive Operations)
syncToSheetBtn?.addEventListener('click', () => {
  if (!linkedSheet || !linkedSheet.spreadsheetId) {
    showToast('먼저 구글 시트를 연동해주세요.', 'error');
    return;
  }
  syncModalCount.textContent = registrations.length;
  syncModalTargetSheet.textContent = linkedSheet.spreadsheetTitle || linkedSheet.spreadsheetId;
  syncSheetModal.hidden = false;
});

cancelSyncSheetBtn?.addEventListener('click', () => {
  syncSheetModal.hidden = true;
});

// Confirm Sync Sheet
confirmSyncSheetBtn?.addEventListener('click', async () => {
  if (!linkedSheet || !linkedSheet.spreadsheetId) return;

  try {
    confirmSyncSheetBtn.disabled = true;
    confirmSyncSheetBtn.textContent = '동기화 중...';
    const token = await ensureAccessToken();

    await syncRegistrationsToSheetAPI(token, linkedSheet.spreadsheetId, registrations);
    syncSheetModal.hidden = true;
    showToast(`${registrations.length}명의 데이터가 구글 시트에 성공적으로 동기화되었습니다!`, 'success');
  } catch (err) {
    console.error('Sync error:', err);
    showToast('구글 시트 동기화 실패: ' + (err.message || '오류 발생'), 'error');
  } finally {
    confirmSyncSheetBtn.disabled = false;
    confirmSyncSheetBtn.textContent = '동기화 진행';
  }
});

// Link Existing Sheet Modal
linkExistingSheetBtn?.addEventListener('click', () => {
  existingSheetInput.value = linkedSheet?.spreadsheetId || '';
  linkSheetModal.hidden = false;
});

cancelLinkSheetBtn?.addEventListener('click', () => {
  linkSheetModal.hidden = true;
});

confirmLinkSheetBtn?.addEventListener('click', async () => {
  const input = existingSheetInput.value.trim();
  if (!input) {
    showToast('구글 시트 URL 또는 ID를 입력해주세요.', 'error');
    return;
  }

  // Extract ID from full URL if pasted
  let sheetId = input;
  const match = input.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  if (match) {
    sheetId = match[1];
  }

  try {
    confirmLinkSheetBtn.disabled = true;
    confirmLinkSheetBtn.textContent = '연결 확인 중...';
    const token = await ensureAccessToken();

    // Verify sheet exists
    const checkRes = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${sheetId}`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });

    if (!checkRes.ok) {
      throw new Error('시트를 찾을 수 없거나 접근 권한이 없습니다.');
    }

    const sheetInfo = await checkRes.json();
    const sheetData = {
      spreadsheetId: sheetId,
      spreadsheetUrl: `https://docs.google.com/spreadsheets/d/${sheetId}`,
      spreadsheetTitle: sheetInfo.properties?.title || '연결된 구글 시트',
      lastSyncedAt: new Date().toISOString()
    };

    await setDoc(doc(db, 'settings', 'google_sheets'), sheetData);
    linkedSheet = sheetData;
    renderSheetStatusUI();
    linkSheetModal.hidden = true;
    showToast(`'${sheetData.spreadsheetTitle}' 시트와 성공적으로 연결되었습니다!`, 'success');
  } catch (err) {
    console.error('Link sheet error:', err);
    showToast('시트 연결 오류: ' + err.message, 'error');
  } finally {
    confirmLinkSheetBtn.disabled = false;
    confirmLinkSheetBtn.textContent = '연결 저장';
  }
});

// Initialize Real-time Firestore Listener
function initOrganizerRealtime() {
  if (unsubscribeSnapshot) {
    unsubscribeSnapshot();
    unsubscribeSnapshot = null;
  }

  if (!currentUser) {
    authRequiredBanner.hidden = false;
    organizerContent.hidden = true;
    return;
  }

  authRequiredBanner.hidden = true;
  organizerContent.hidden = false;
  liveSyncStatusBadge.textContent = '동기화 중...';
  liveSyncStatusBadge.className = 'status-badge status-syncing';

  try {
    const q = query(collection(db, 'registrations'), orderBy('createdAt', 'desc'));
    unsubscribeSnapshot = onSnapshot(
      q,
      (snapshot) => {
        liveSyncStatusBadge.textContent = '실시간 연결됨 (onSnapshot)';
        liveSyncStatusBadge.className = 'status-badge status-live';

        const list = [];
        snapshot.forEach((docSnap) => {
          list.push({ id: docSnap.id, ...docSnap.data() });
        });
        registrations = list;
        renderOrganizerDashboard();
      },
      (error) => {
        liveSyncStatusBadge.textContent = '연결 오류';
        liveSyncStatusBadge.className = 'status-badge status-error';
        try {
          handleFirestoreError(error, OperationType.LIST, 'registrations');
        } catch (_) {}
      }
    );
  } catch (error) {
    try {
      handleFirestoreError(error, OperationType.LIST, 'registrations');
    } catch (_) {}
  }
}

// Render Organizer Dashboard (KPIs & Table)
function renderOrganizerDashboard() {
  // 1. Calculate Stats
  const total = registrations.length;
  const confirmed = registrations.filter(r => r.status === 'confirmed').length;
  const pending = registrations.filter(r => r.status === 'pending').length;
  const cancelled = registrations.filter(r => r.status === 'cancelled').length;

  statTotal.textContent = total;
  statConfirmed.textContent = confirmed;
  statPending.textContent = pending;
  statCancelled.textContent = cancelled;

  // 2. Filter & Sort
  let filtered = [...registrations];

  // Search filter
  if (currentFilter.search) {
    const s = currentFilter.search.toLowerCase();
    filtered = filtered.filter(r =>
      (r.name && r.name.toLowerCase().includes(s)) ||
      (r.email && r.email.toLowerCase().includes(s)) ||
      (r.phone && r.phone.toLowerCase().includes(s)) ||
      (r.job && r.job.toLowerCase().includes(s)) ||
      (r.question && r.question.toLowerCase().includes(s))
    );
  }

  // Status filter
  if (currentFilter.status !== 'all') {
    filtered = filtered.filter(r => r.status === currentFilter.status);
  }

  // Job filter
  if (currentFilter.job !== 'all') {
    filtered = filtered.filter(r => r.job === currentFilter.job);
  }

  // Sort
  if (currentFilter.sortBy === 'name') {
    filtered.sort((a, b) => (a.name || '').localeCompare(b.name || '', 'ko'));
  } else if (currentFilter.sortBy === 'oldest') {
    filtered.sort((a, b) => new Date(a.createdAt || 0) - new Date(b.createdAt || 0));
  } else {
    filtered.sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
  }

  applicantCountLabel.textContent = `총 ${filtered.length}명 표시 중`;

  // 3. Render Table
  applicantsTableBody.innerHTML = '';
  if (filtered.length === 0) {
    emptyApplicantsState.hidden = false;
    return;
  }
  emptyApplicantsState.hidden = true;

  filtered.forEach(reg => {
    const tr = document.createElement('tr');
    tr.id = `row-${reg.id}`;

    // Format date
    const d = new Date(reg.createdAt);
    const dateFormatted = !isNaN(d.getTime())
      ? `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
      : '-';

    const statusBadgeClass =
      reg.status === 'confirmed' ? 'badge-confirmed' :
      reg.status === 'cancelled' ? 'badge-cancelled' : 'badge-pending';

    tr.innerHTML = `
      <td class="col-date">${dateFormatted}</td>
      <td class="col-name"><strong>${escapeHtml(reg.name)}</strong></td>
      <td class="col-contact">
        <div class="email-text">${escapeHtml(reg.email)}</div>
        <small class="phone-text">${escapeHtml(reg.phone || '연락처 없음')}</small>
      </td>
      <td class="col-job"><span class="job-chip">${escapeHtml(reg.job || '미지정')}</span></td>
      <td class="col-question">
        ${reg.question ? `<span class="question-snippet" title="${escapeHtml(reg.question)}">${escapeHtml(reg.question)}</span>` : '<span class="text-muted">-</span>'}
      </td>
      <td class="col-status">
        <select class="status-select ${statusBadgeClass}" data-id="${reg.id}">
          <option value="pending" ${reg.status === 'pending' ? 'selected' : ''}>대기 중</option>
          <option value="confirmed" ${reg.status === 'confirmed' ? 'selected' : ''}>참가 확정</option>
          <option value="cancelled" ${reg.status === 'cancelled' ? 'selected' : ''}>신청 취소</option>
        </select>
      </td>
      <td class="col-actions">
        <button type="button" class="btn-action btn-detail" data-id="${reg.id}" title="상세보기">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>
        </button>
        <button type="button" class="btn-action btn-delete" data-id="${reg.id}" data-name="${escapeHtml(reg.name)}" title="삭제">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg>
        </button>
      </td>
    `;

    applicantsTableBody.appendChild(tr);
  });
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Table interactions (Status change, Details, Delete)
applicantsTableBody?.addEventListener('change', async (e) => {
  if (e.target.classList.contains('status-select')) {
    const id = e.target.dataset.id;
    const newStatus = e.target.value;
    const reg = registrations.find(r => r.id === id);
    if (!reg) return;

    try {
      e.target.disabled = true;
      const regRef = doc(db, 'registrations', id);
      await updateDoc(regRef, {
        status: newStatus
      });
      showToast(`'${reg.name}' 님의 상태가 변경되었습니다.`, 'success');

      // If sheet is linked and token exists, update sheet in background
      if (linkedSheet?.spreadsheetId && cachedAccessToken) {
        syncRegistrationsToSheetAPI(cachedAccessToken, linkedSheet.spreadsheetId, registrations).catch(console.warn);
      }
    } catch (err) {
      try {
        handleFirestoreError(err, OperationType.UPDATE, `registrations/${id}`);
      } catch (_) {}
      showToast('상태 변경 실패: 주최자 권한을 확인해주세요.', 'error');
      renderOrganizerDashboard();
    }
  }
});

applicantsTableBody?.addEventListener('click', (e) => {
  const detailBtn = e.target.closest('.btn-detail');
  if (detailBtn) {
    const id = detailBtn.dataset.id;
    openDetailModal(id);
    return;
  }

  const deleteBtn = e.target.closest('.btn-delete');
  if (deleteBtn) {
    const id = deleteBtn.dataset.id;
    const name = deleteBtn.dataset.name;
    openDeleteModal(id, name);
  }
});

// Detail Modal
function openDetailModal(id) {
  const reg = registrations.find(r => r.id === id);
  if (!reg) return;

  const d = new Date(reg.createdAt);
  const dateFormatted = !isNaN(d.getTime()) ? d.toLocaleString('ko-KR') : reg.createdAt;

  detailContent.innerHTML = `
    <div class="detail-grid">
      <div class="detail-row">
        <label>신청자 ID</label>
        <span class="font-mono text-xs">${escapeHtml(reg.id)}</span>
      </div>
      <div class="detail-row">
        <label>이름</label>
        <strong>${escapeHtml(reg.name)}</strong>
      </div>
      <div class="detail-row">
        <label>이메일</label>
        <a href="mailto:${escapeHtml(reg.email)}" class="link">${escapeHtml(reg.email)}</a>
      </div>
      <div class="detail-row">
        <label>연락처</label>
        <span>${escapeHtml(reg.phone || '입력 안 됨')}</span>
      </div>
      <div class="detail-row">
        <label>직군 / 소속</label>
        <span>${escapeHtml(reg.job || '선택 안 됨')}</span>
      </div>
      <div class="detail-row">
        <label>신청 일시</label>
        <span>${dateFormatted}</span>
      </div>
      <div class="detail-row full-width">
        <label>사전 질문 및 기대평</label>
        <div class="question-box">${escapeHtml(reg.question || '작성된 사전 질문이 없습니다.')}</div>
      </div>
    </div>
  `;
  detailModal.hidden = false;
}

closeDetailModalBtn?.addEventListener('click', () => {
  detailModal.hidden = true;
});

// Delete Modal
function openDeleteModal(id, name) {
  pendingDeleteId = id;
  deleteModalName.textContent = name;
  deleteModal.hidden = false;
}

cancelDeleteBtn?.addEventListener('click', () => {
  pendingDeleteId = null;
  deleteModal.hidden = true;
});

confirmDeleteBtn?.addEventListener('click', async () => {
  if (!pendingDeleteId) return;

  confirmDeleteBtn.disabled = true;
  confirmDeleteBtn.textContent = '삭제 중...';

  try {
    const targetRef = doc(db, 'registrations', pendingDeleteId);
    await deleteDoc(targetRef);
    showToast('신청자가 성공적으로 삭제되었습니다.', 'info');
    deleteModal.hidden = true;
  } catch (err) {
    try {
      handleFirestoreError(err, OperationType.DELETE, `registrations/${pendingDeleteId}`);
    } catch (_) {}
    showToast('삭제 권한이 없거나 실패했습니다.', 'error');
  } finally {
    confirmDeleteBtn.disabled = false;
    confirmDeleteBtn.textContent = '영구 삭제';
    pendingDeleteId = null;
  }
});

// Filters & Search Event Listeners
searchInput?.addEventListener('input', (e) => {
  currentFilter.search = e.target.value.trim();
  renderOrganizerDashboard();
});

statusFilterSelect?.addEventListener('change', (e) => {
  currentFilter.status = e.target.value;
  renderOrganizerDashboard();
});

jobFilterSelect?.addEventListener('change', (e) => {
  currentFilter.job = e.target.value;
  renderOrganizerDashboard();
});

sortBySelect?.addEventListener('change', (e) => {
  currentFilter.sortBy = e.target.value;
  renderOrganizerDashboard();
});

// Action: Copy All Emails
copyEmailsBtn?.addEventListener('click', () => {
  if (registrations.length === 0) {
    showToast('복사할 신청자 이메일이 없습니다.', 'info');
    return;
  }
  const emails = registrations.map(r => r.email).filter(Boolean).join('; ');
  navigator.clipboard.writeText(emails).then(() => {
    showToast(`${registrations.length}개의 이메일 주소가 클립보드에 복사되었습니다!`, 'success');
  }).catch(() => {
    showToast('클립보드 복사 권한이 없습니다.', 'error');
  });
});

// Action: Export CSV
exportCsvBtn?.addEventListener('click', () => {
  if (registrations.length === 0) {
    showToast('내보낼 신청자 데이터가 없습니다.', 'info');
    return;
  }
  const headers = ['신청ID', '이름', '이메일', '연락처', '직군', '사전질문', '상태', '신청일시'];
  const rows = registrations.map(r => [
    `"${(r.id || '').replace(/"/g, '""')}"`,
    `"${(r.name || '').replace(/"/g, '""')}"`,
    `"${(r.email || '').replace(/"/g, '""')}"`,
    `"${(r.phone || '').replace(/"/g, '""')}"`,
    `"${(r.job || '').replace(/"/g, '""')}"`,
    `"${(r.question || '').replace(/"/g, '""')}"`,
    `"${r.status === 'confirmed' ? '확정' : r.status === 'cancelled' ? '취소' : '대기'}"`,
    `"${(r.createdAt || '').replace(/"/g, '""')}"`
  ]);

  const csvContent = '\uFEFF' + [headers.join(','), ...rows.map(r => r.join(','))].join('\r\n');
  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `웨비나_참가신청자명단_${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  showToast('CSV 다운로드가 완료되었습니다.', 'success');
});

// Action: Generate Quick Sample Applicant
generateSampleBtn?.addEventListener('click', async () => {
  const sampleNames = ['김민수', '이지원', '박서준', '최유진', '정현우', '강다은', '윤도현'];
  const sampleJobs = ['기획/PM', '개발자', '디자이너', '마케터', '학생'];
  const sampleQuestions = [
    'AI 프로덕트의 핵심 KPI 설정 방법이 궁금합니다.',
    '비개발자가 LLM 프로토타이핑할 때 가장 유용한 툴은 무엇인가요?',
    '실제 프로덕션 배포 시 보안 체크리스트가 알고 싶습니다.',
    '사용자 피드백 수집과 프롬프트 튜닝 주기 질문드립니다.'
  ];

  const randomName = sampleNames[Math.floor(Math.random() * sampleNames.length)];
  const randomJob = sampleJobs[Math.floor(Math.random() * sampleJobs.length)];
  const randomQuestion = sampleQuestions[Math.floor(Math.random() * sampleQuestions.length)];
  const randomEmail = `sample.${Date.now().toString(36)}@example.com`;
  const regId = 'reg_' + Date.now() + '_' + Math.random().toString(36).substring(2, 6);

  try {
    generateSampleBtn.disabled = true;
    const regRef = doc(db, 'registrations', regId);
    const newReg = {
      name: randomName,
      email: randomEmail,
      phone: '010-' + Math.floor(1000 + Math.random() * 9000) + '-' + Math.floor(1000 + Math.random() * 9000),
      job: randomJob,
      question: randomQuestion,
      status: 'pending',
      createdAt: new Date().toISOString()
    };
    await setDoc(regRef, newReg);
    showToast(`테스트 참가자 '${randomName}' 등록 완료! 실시간 목록에 추가되었습니다.`, 'success');
  } catch (err) {
    showToast('테스트 데이터 생성 실패: ' + err.message, 'error');
  } finally {
    generateSampleBtn.disabled = false;
  }
});

// Close modal when clicking outside
window.addEventListener('click', (e) => {
  if (e.target === deleteModal) deleteModal.hidden = true;
  if (e.target === detailModal) detailModal.hidden = true;
  if (e.target === syncSheetModal) syncSheetModal.hidden = true;
  if (e.target === linkSheetModal) linkSheetModal.hidden = true;
});
