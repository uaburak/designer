import { getApp, getApps, initializeApp } from "firebase/app";
import { getFirestore, initializeFirestore, type Firestore } from "firebase/firestore";
import { getStorage } from "firebase/storage";
import { browserLocalPersistence, browserPopupRedirectResolver, getAuth, indexedDBLocalPersistence, initializeAuth, type Auth } from "firebase/auth";
import { FIREBASE_CONFIG } from "@shared/firebaseConfig";
import { isDesktop } from "@/app/native";

const app = getApps().length ? getApp() : initializeApp(FIREBASE_CONFIG);

/** Firestore, taking `undefined` fields as absent (an optional field left unset is simply not written). */
function firestore(): Firestore {
  try {
    return initializeFirestore(app, { ignoreUndefinedProperties: true });
  } catch {
    // Already made (a hot reload): the same one.
    return getFirestore(app);
  }
}

/**
 * The sign-in, kept on this computer (IndexedDB — every tab of the app reads
 * the same one). In the desktop app Google is signed in to in the browser
 * and handed over (see lib/auth.ts): no popup here. In a browser (npm run
 * web) it is Firebase's popup.
 */
function authOf(): Auth {
  try {
    return initializeAuth(app, { persistence: [indexedDBLocalPersistence, browserLocalPersistence], popupRedirectResolver: isDesktop ? undefined : browserPopupRedirectResolver });
  } catch {
    return getAuth(app);
  }
}

export const db = firestore();
export const storage = getStorage(app);
export const auth = authOf();
