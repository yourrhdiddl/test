import { initializeApp } from 'firebase/app';
import { getAuth } from 'firebase/auth';
import {
  getFirestore,
  doc,
  setDoc,
  collection,
  onSnapshot,
  getDocFromServer
} from 'firebase/firestore';

// 1. Load Firebase configuration
const configRes = await fetch('/firebase-applet-config.json');
const firebaseConfig = await configRes.json();

const app = initializeApp(firebaseConfig);
export const db = getFirestore(app, firebaseConfig.firestoreDatabaseId);
export const auth = getAuth(app);

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

// DOM Elements
const regForm = document.getElementById('regForm');
const formSubmitBtn = document.getElementById('formSubmitBtn');
const formErrorAlert = document.getElementById('formErrorAlert');
const formViewWrapper = document.getElementById('formViewWrapper');
const successViewWrapper = document.getElementById('successViewWrapper');
const registerAnotherBtn = document.getElementById('registerAnotherBtn');
const scrollToApplyBtn = document.getElementById('scrollToApplyBtn');
const liveCounterBadge = document.getElementById('liveCounterBadge');

// Smooth scroll to application form
scrollToApplyBtn?.addEventListener('click', (e) => {
  e.preventDefault();
  formViewWrapper?.scrollIntoView({ behavior: 'smooth', block: 'start' });
});

// Toast notification helper
function showToast(message, type = 'info') {
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.textContent = message;
  document.body.appendChild(toast);
  requestAnimationFrame(() => toast.classList.add('show'));
  setTimeout(() => {
    toast.classList.remove('show');
    setTimeout(() => toast.remove(), 300);
  }, 3200);
}

function showFormError(msg) {
  formErrorAlert.textContent = msg;
  formErrorAlert.hidden = false;
}

// Handle Registration Form Submit
regForm?.addEventListener('submit', async (e) => {
  e.preventDefault();
  formErrorAlert.textContent = '';
  formErrorAlert.hidden = true;

  const name = regForm.name.value.trim();
  const email = regForm.email.value.trim();
  const phone = regForm.phone.value.trim();
  const job = regForm.job.value;
  const question = regForm.question.value.trim();
  const agree = regForm.agree.checked;

  // Validation
  if (!name || name.length < 1 || name.length > 50) {
    showFormError('이름을 1자 이상 50자 이하로 올바르게 입력해주세요.');
    return;
  }
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 100) {
    showFormError('올바른 이메일 주소를 입력해주세요 (최대 100자).');
    return;
  }
  if (phone && phone.length > 30) {
    showFormError('연락처는 30자 이내로 입력해주세요.');
    return;
  }
  if (job && job.length > 50) {
    showFormError('직군은 50자 이내로 입력해주세요.');
    return;
  }
  if (question && question.length > 500) {
    showFormError('사전 질문은 500자 이내로 작성해주세요.');
    return;
  }
  if (!agree) {
    showFormError('웨비나 참여 안내를 위한 개인정보 수집에 동의해주세요.');
    return;
  }

  // Create document payload
  const regId = 'reg_' + Date.now() + '_' + Math.random().toString(36).substring(2, 8);
  const payload = {
    name,
    email,
    status: 'pending',
    createdAt: new Date().toISOString()
  };
  if (phone) payload.phone = phone;
  if (job) payload.job = job;
  if (question) payload.question = question;

  formSubmitBtn.disabled = true;
  formSubmitBtn.innerHTML = `
    <svg class="spinner" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
      <circle cx="12" cy="12" r="10" stroke-opacity="0.25"></circle>
      <path d="M12 2a10 10 0 0 1 10 10"></path>
    </svg>
    신청 처리 중...
  `;

  try {
    const regRef = doc(db, 'registrations', regId);
    await setDoc(regRef, payload);

    // Show success view
    document.getElementById('successApplicantName').textContent = name;
    document.getElementById('successApplicantEmail').textContent = email;
    document.getElementById('successApplicantJob').textContent = job || '미지정';
    document.getElementById('successRegId').textContent = regId;

    formViewWrapper.hidden = true;
    successViewWrapper.hidden = false;
    regForm.reset();
    showToast('웨비나 참가 신청이 성공적으로 접수되었습니다!', 'success');
  } catch (error) {
    formSubmitBtn.disabled = false;
    formSubmitBtn.textContent = '웨비나 무료 신청하기';
    try {
      handleFirestoreError(error, OperationType.CREATE, `registrations/${regId}`);
    } catch (_) {}
    showFormError('신청 중 오류가 발생했습니다. 잠시 후 다시 시도해주세요.');
  }
});

registerAnotherBtn?.addEventListener('click', () => {
  successViewWrapper.hidden = true;
  formViewWrapper.hidden = false;
  formSubmitBtn.disabled = false;
  formSubmitBtn.textContent = '웨비나 무료 신청하기';
  formViewWrapper.scrollIntoView({ behavior: 'smooth', block: 'start' });
});
