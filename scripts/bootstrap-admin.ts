import 'dotenv/config';
import admin from 'firebase-admin';

const uid = process.env.ADMIN_BOOTSTRAP_UID?.trim() ?? '';
const expectedEmail = process.env.ADMIN_BOOTSTRAP_EMAIL?.trim().toLowerCase() ?? '';
const confirmation = process.env.ADMIN_BOOTSTRAP_CONFIRM ?? '';
const projectId = process.env.FIREBASE_PROJECT_ID || process.env.GCLOUD_PROJECT || process.env.VITE_FIREBASE_PROJECT_ID;

if (!uid || !expectedEmail || confirmation !== 'CREATE_FIRST_LEARNPULSE_ADMIN') {
  throw new Error('Set ADMIN_BOOTSTRAP_UID, ADMIN_BOOTSTRAP_EMAIL, and ADMIN_BOOTSTRAP_CONFIRM=CREATE_FIRST_LEARNPULSE_ADMIN for this one-time operation.');
}

if (admin.apps.length) {
  throw new Error('This bootstrap script must run as a separate one-time process.');
}

const app = admin.initializeApp({
  credential: admin.credential.applicationDefault(),
  ...(projectId ? { projectId } : {}),
});

try {
  const auth = app.auth();
  const firestore = app.firestore();
  const target = await auth.getUser(uid);
  if (!target.email || target.email.trim().toLowerCase() !== expectedEmail || !target.emailVerified || target.disabled) {
    throw new Error('The selected Firebase Auth account must match ADMIN_BOOTSTRAP_EMAIL, be email-verified, and be enabled.');
  }

  const existingAdmins = await firestore.collection('users').where('role', '==', 'admin').limit(1).get();
  if (!existingAdmins.empty) throw new Error('An Admin role already exists. This script only provisions the first administrator.');

  const bootstrapRef = firestore.collection('system').doc('adminBootstrap');
  const userRef = firestore.collection('users').doc(uid);
  const [existingStudent, existingFaculty] = await Promise.all([
    firestore.collection('students').doc(uid).get(),
    firestore.collection('faculty').doc(uid).get(),
  ]);
  if (existingStudent.exists || existingFaculty.exists) {
    throw new Error('Choose a dedicated Auth account without an existing student or faculty profile.');
  }
  await firestore.runTransaction(async (transaction) => {
    const [bootstrap, user, adminCheck] = await Promise.all([
      transaction.get(bootstrapRef),
      transaction.get(userRef),
      transaction.get(firestore.collection('users').where('role', '==', 'admin').limit(1)),
    ]);
    if (bootstrap.exists || !adminCheck.empty) throw new Error('First Admin setup has already been completed.');
    if (user.exists) throw new Error('Choose a dedicated Auth account without an existing users profile.');
    const now = admin.firestore.FieldValue.serverTimestamp();
    transaction.create(userRef, {
      uid,
      email: target.email!.trim().toLowerCase(),
      role: 'admin',
      status: 'active',
      updatedAt: now,
    });
    transaction.create(bootstrapRef, { uid, completedAt: now });
  });

  console.info('First LearnPulse administrator provisioned:', { uid, projectId: app.options.projectId ?? 'application-default' });
} finally {
  await app.delete();
}
