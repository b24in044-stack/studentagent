import { getApps, initializeApp, type FirebaseApp } from 'firebase/app';
import { getAuth, signInWithEmailAndPassword, createUserWithEmailAndPassword, signOut, onAuthStateChanged, sendPasswordResetEmail as firebaseSendPasswordResetEmail, type UserCredential, type User } from 'firebase/auth';

const requiredConfigKeys = ['VITE_FIREBASE_API_KEY', 'VITE_FIREBASE_AUTH_DOMAIN', 'VITE_FIREBASE_PROJECT_ID', 'VITE_FIREBASE_STORAGE_BUCKET', 'VITE_FIREBASE_MESSAGING_SENDER_ID', 'VITE_FIREBASE_APP_ID'] as const;

const firebaseConfig = Object.fromEntries(requiredConfigKeys.map((key) => [key, (import.meta.env as Record<string, string | undefined>)[key]?.trim() ?? ''])) as Record<(typeof requiredConfigKeys)[number], string>;

const firebaseConfigured = requiredConfigKeys.every((key) => Boolean(firebaseConfig[key]));

const existingDefaultApp = getApps().find((app) => app.name === '[DEFAULT]');
const firebaseProjectMismatch = Boolean(
  existingDefaultApp
  && firebaseConfig.VITE_FIREBASE_PROJECT_ID
  && existingDefaultApp.options.projectId !== firebaseConfig.VITE_FIREBASE_PROJECT_ID,
);

export const firebaseApp: FirebaseApp | null = firebaseConfigured && !firebaseProjectMismatch
  ? existingDefaultApp ?? initializeApp({
        apiKey: firebaseConfig.VITE_FIREBASE_API_KEY,
        authDomain: firebaseConfig.VITE_FIREBASE_AUTH_DOMAIN,
        projectId: firebaseConfig.VITE_FIREBASE_PROJECT_ID,
        storageBucket: firebaseConfig.VITE_FIREBASE_STORAGE_BUCKET,
        messagingSenderId: firebaseConfig.VITE_FIREBASE_MESSAGING_SENDER_ID,
        appId: firebaseConfig.VITE_FIREBASE_APP_ID,
      })
  : null;

export const auth = firebaseApp ? getAuth(firebaseApp) : null;
export const firebaseConfigurationMessage = firebaseProjectMismatch
  ? 'The initialized Firebase app does not match VITE_FIREBASE_PROJECT_ID. Restart the app with one consistent Firebase project configuration.'
  : 'Firebase is not configured. Add VITE_FIREBASE_* values to your .env file and restart the app.';

export const firebaseConfiguredFlag = Boolean(firebaseApp && auth);

export async function signInWithFirebase(email: string, password: string): Promise<UserCredential> {
  if (!auth) throw new Error(firebaseConfigurationMessage);
  return signInWithEmailAndPassword(auth, email, password);
}

export async function registerFirebaseUser(email: string, password: string): Promise<UserCredential> {
  if (!auth) throw new Error(firebaseConfigurationMessage);
  return createUserWithEmailAndPassword(auth, email, password);
}

export async function signOutFirebase(): Promise<void> {
  if (!auth) return;
  await signOut(auth);
}

export async function sendPasswordResetEmail(email: string, redirectUrl: string): Promise<void> {
  if (!auth) throw new Error(firebaseConfigurationMessage);
  await firebaseSendPasswordResetEmail(auth, email, { url: redirectUrl });
}

export function observeAuthState(callback: (user: User | null) => void) {
  if (!auth) {
    callback(null);
    return () => undefined;
  }
  return onAuthStateChanged(auth, callback);
}
