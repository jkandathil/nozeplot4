import React, { useEffect, useState, useCallback } from 'react';
import {
    GoogleAuthProvider,
    signInWithPopup,
    signInWithRedirect,
    getRedirectResult,
    signOut,
    onAuthStateChanged,
    signInWithEmailAndPassword,
    createUserWithEmailAndPassword,
    sendEmailVerification,
} from 'firebase/auth';
import { LogIn, LogOut, ShieldAlert, Mail, RefreshCw } from 'lucide-react';
import { getFirebaseAuth } from '../auth/firebaseApp';
import { isEmailDomainAllowed, allowedDomainsLabel, getAllowedEmailDomains } from '../auth/authEnv';
import { getEmailVerificationContinueUrl } from '../auth/emailVerification';
import './AuthGate.css';

function formatAuthError(e) {
    const code = e?.code || '';
    const msg = e?.message || 'Sign-in failed.';
    if (code === 'auth/unauthorized-domain') {
        return `${msg} Add this site’s domain under Firebase → Authentication → Settings → Authorized domains.`;
    }
    if (code === 'auth/operation-not-allowed') {
        return 'Google sign-in is disabled. In Firebase Console → Authentication → Sign-in method, enable Google.';
    }
    if (code === 'auth/popup-blocked') {
        return 'Popup was blocked. Try “Continue with Google (full page)” below or allow popups for this site.';
    }
    return msg;
}

export default function AuthGate({ children }) {
    const [ready, setReady] = useState(false);
    const [gateError, setGateError] = useState('');
    const [firebaseUser, setFirebaseUser] = useState(null);
    const [appAllowed, setAppAllowed] = useState(false);
    const [verifyInfo, setVerifyInfo] = useState('');

    const auth = getFirebaseAuth();

    const applyFirebaseUser = useCallback(async (u) => {
        if (!u) {
            setFirebaseUser(null);
            setAppAllowed(false);
            return;
        }
        try {
            await u.reload();
        } catch {
            /* ignore reload errors */
        }
        const cur = auth.currentUser;
        if (!cur) {
            setFirebaseUser(null);
            setAppAllowed(false);
            return;
        }
        if (!cur.email) {
            await signOut(auth);
            setFirebaseUser(null);
            setAppAllowed(false);
            setGateError('Your account has no email on file. Access denied.');
            return;
        }
        if (!isEmailDomainAllowed(cur.email)) {
            await signOut(auth);
            setFirebaseUser(null);
            setAppAllowed(false);
            setGateError(
                `This app is limited to: ${allowedDomainsLabel()}. You signed in as ${cur.email}.`
            );
            return;
        }
        if (!cur.emailVerified) {
            setFirebaseUser(cur);
            setAppAllowed(false);
            return;
        }
        setFirebaseUser(cur);
        setAppAllowed(true);
    }, [auth]);

    useEffect(() => {
        if (!auth) {
            setGateError(
                'Firebase is not configured. Set VITE_FIREBASE_API_KEY, VITE_FIREBASE_AUTH_DOMAIN, VITE_FIREBASE_PROJECT_ID, and VITE_FIREBASE_APP_ID (see .env.example), then rebuild.'
            );
            setReady(true);
            return;
        }

        getRedirectResult(auth).catch((e) => {
            const c = e?.code || '';
            if (c && c !== 'auth/popup-closed-by-user') {
                setGateError(formatAuthError(e));
            }
        });

        const unsub = onAuthStateChanged(auth, async (u) => {
            setGateError('');
            if (!u) {
                setFirebaseUser(null);
                setAppAllowed(false);
                setReady(true);
                return;
            }
            await applyFirebaseUser(u);
            setReady(true);
        });
        return () => unsub();
    }, [auth, applyFirebaseUser]);

    const runGoogleProvider = useCallback(() => {
        const provider = new GoogleAuthProvider();
        provider.setCustomParameters({ prompt: 'select_account' });
        return provider;
    }, []);

    const handleGoogleSignIn = useCallback(async () => {
        if (!auth) return;
        setGateError('');
        try {
            await signInWithPopup(auth, runGoogleProvider());
        } catch (e) {
            const code = e?.code || '';
            if (code === 'auth/popup-closed-by-user' || code === 'auth/cancelled-popup-request') return;
            setGateError(formatAuthError(e));
        }
    }, [auth, runGoogleProvider]);

    const handleGoogleSignInRedirect = useCallback(async () => {
        if (!auth) return;
        setGateError('');
        try {
            await signInWithRedirect(auth, runGoogleProvider());
        } catch (e) {
            setGateError(formatAuthError(e));
        }
    }, [auth, runGoogleProvider]);

    const handleSignOut = useCallback(async () => {
        if (!auth) return;
        setGateError('');
        await signOut(auth);
    }, [auth]);

    const handleResendVerification = useCallback(async () => {
        if (!auth?.currentUser) return;
        setGateError('');
        setVerifyInfo('');
        try {
            const url = getEmailVerificationContinueUrl();
            await sendEmailVerification(auth.currentUser, url ? { url, handleCodeInApp: false } : undefined);
            setVerifyInfo('Verification email sent. Check inbox and spam.');
        } catch (e) {
            setGateError(e?.message || 'Could not send verification email.');
        }
    }, [auth]);

    const handleRecheckVerification = useCallback(async () => {
        if (!auth?.currentUser) return;
        setGateError('');
        try {
            await auth.currentUser.reload();
            const u = auth.currentUser;
            if (u?.emailVerified && isSignInEmailAllowed(u.email || '')) {
                setFirebaseUser(u);
                setAppAllowed(true);
            } else if (u && !u.emailVerified) {
                setGateError('Email is not verified yet. Open the link in the message from Firebase.');
            }
        } catch (e) {
            setGateError(e?.message || 'Could not refresh account.');
        }
    }, [auth]);

    if (!ready) {
        return (
            <div className="auth-gate-screen">
                <div className="auth-gate-card">
                    <p className="auth-gate-muted">Checking session…</p>
                </div>
            </div>
        );
    }

    if (!auth) {
        return (
            <div className="auth-gate-screen">
                <div className="auth-gate-card">
                    <ShieldAlert className="auth-gate-icon" size={40} />
                    <h1 className="auth-gate-title">Configuration needed</h1>
                    <p className="auth-gate-muted">{gateError}</p>
                </div>
            </div>
        );
    }

    if (appAllowed && firebaseUser) {
        return (
            <div className="auth-root">
                <div className="auth-session-bar">
                    <span className="auth-session-email" title={firebaseUser.email || ''}>
                        {firebaseUser.email}
                    </span>
                    <button type="button" className="auth-session-out" onClick={handleSignOut}>
                        <LogOut size={14} />
                        Sign out
                    </button>
                </div>
                {children}
            </div>
        );
    }

    if (firebaseUser && !appAllowed) {
        return (
            <div className="auth-gate-screen">
                <div className="auth-gate-card auth-gate-card-wide">
                    <Mail className="auth-gate-icon" size={40} />
                    <h1 className="auth-gate-title">Verify your email</h1>
                    <p className="auth-gate-muted">
                        We sent a link to <strong>{firebaseUser.email}</strong>. Open it to confirm your address, then
                        click <strong>I’ve verified</strong> below.
                    </p>
                    {gateError ? <p className="auth-gate-error">{gateError}</p> : null}
                    {verifyInfo ? <p className="auth-gate-success">{verifyInfo}</p> : null}
                    <div className="auth-verify-actions">
                        <button type="button" className="auth-gate-primary-btn" onClick={handleRecheckVerification}>
                            <RefreshCw size={16} />
                            I’ve verified — continue
                        </button>
                        <button type="button" className="auth-gate-secondary-btn" onClick={handleResendVerification}>
                            Resend verification email
                        </button>
                        <button type="button" className="auth-gate-text-btn" onClick={handleSignOut}>
                            Use a different account
                        </button>
                    </div>
                </div>
            </div>
        );
    }

    return (
        <div className="auth-gate-screen">
            <div className="auth-gate-card auth-gate-card-wide">
                <ShieldAlert className="auth-gate-icon" size={40} />
                <h1 className="auth-gate-title">Sign in</h1>
                <p className="auth-gate-muted">
                    Access is for <strong>{allowedDomainsLabel()}</strong> only. You must use a <strong>verified</strong>{' '}
                    email (Google accounts are usually verified; email sign-up gets a Firebase verification link).
                </p>
                {gateError ? <p className="auth-gate-error">{gateError}</p> : null}
                <button type="button" className="auth-gate-google-btn" onClick={handleGoogleSignIn}>
                    <LogIn size={18} />
                    Continue with Google
                </button>
                <button type="button" className="auth-gate-secondary-btn" onClick={handleGoogleSignInRedirect}>
                    Continue with Google (full page)
                </button>
                <p className="auth-gate-hint">
                    If you see “The requested action is invalid”: use the full-page option, confirm <strong>localhost</strong> is in
                    Firebase authorized domains, and in{' '}
                    <a href="https://console.cloud.google.com/apis/credentials" target="_blank" rel="noreferrer">
                        Google Cloud → Credentials
                    </a>{' '}
                    open your <strong>Web client</strong> (OAuth 2.0) and add{' '}
                    <code>http://localhost:5174</code> under <strong>Authorized JavaScript origins</strong>.
                </p>
                <div className="auth-gate-divider">
                    <span>or</span>
                </div>
                <EmailPasswordForm auth={auth} setGateError={setGateError} />
            </div>
        </div>
    );
}

function EmailPasswordForm({ auth, setGateError }) {
    const [mode, setMode] = useState('signin');
    const [email, setEmail] = useState('');
    const [password, setPassword] = useState('');
    const [password2, setPassword2] = useState('');
    const [busy, setBusy] = useState(false);
    const [formSuccess, setFormSuccess] = useState('');

    const onSubmit = async (e) => {
        e.preventDefault();
        setGateError('');
        setFormSuccess('');
        const em = email.trim().toLowerCase();
        if (!em) {
            setGateError('Enter your email.');
            return;
        }
        if (!isEmailDomainAllowed(em)) {
            setGateError(`Email must be at: ${allowedDomainsLabel()}`);
            return;
        }
        if (!password || password.length < 6) {
            setGateError('Password must be at least 6 characters.');
            return;
        }
        if (mode === 'register' && password !== password2) {
            setGateError('Passwords do not match.');
            return;
        }
        setBusy(true);
        try {
            if (mode === 'signin') {
                await signInWithEmailAndPassword(auth, em, password);
            } else {
                const cred = await createUserWithEmailAndPassword(auth, em, password);
                const url = getEmailVerificationContinueUrl();
                await sendEmailVerification(cred.user, url ? { url, handleCodeInApp: false } : undefined);
                setFormSuccess('Check your email for a verification link from Firebase, then use “I’ve verified” on the next screen.');
            }
        } catch (err) {
            const code = err?.code || '';
            if (code === 'auth/email-already-in-use') {
                setGateError('That email is already registered. Try signing in or reset password in Firebase Console.');
            } else if (code === 'auth/invalid-credential' || code === 'auth/wrong-password') {
                setGateError('Wrong email or password.');
            } else if (code === 'auth/invalid-email') {
                setGateError('Invalid email address.');
            } else if (code === 'auth/too-many-requests') {
                setGateError('Too many attempts. Try again later.');
            } else {
                setGateError(err?.message || 'Request failed.');
            }
        } finally {
            setBusy(false);
        }
    };

    return (
        <form className="auth-gate-email-form" onSubmit={onSubmit}>
            {formSuccess ? <p className="auth-gate-success">{formSuccess}</p> : null}
            <label className="auth-gate-field-label" htmlFor="auth-email">
                Email
            </label>
            <input
                id="auth-email"
                className="auth-gate-input"
                type="email"
                autoComplete="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder={`you@${getAllowedEmailDomains()[0] || 'noze.ca'}`}
            />
            <label className="auth-gate-field-label" htmlFor="auth-password">
                Password
            </label>
            <input
                id="auth-password"
                className="auth-gate-input"
                type="password"
                autoComplete={mode === 'signin' ? 'current-password' : 'new-password'}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Min. 6 characters"
            />
            {mode === 'register' ? (
                <>
                    <label className="auth-gate-field-label" htmlFor="auth-password2">
                        Confirm password
                    </label>
                    <input
                        id="auth-password2"
                        className="auth-gate-input"
                        type="password"
                        autoComplete="new-password"
                        value={password2}
                        onChange={(e) => setPassword2(e.target.value)}
                    />
                </>
            ) : null}
            <button type="submit" className="auth-gate-primary-btn" disabled={busy}>
                {busy ? 'Please wait…' : mode === 'signin' ? 'Sign in with email' : 'Create account & send verification'}
            </button>
            <button
                type="button"
                className="auth-gate-text-btn"
                onClick={() => {
                    setMode(mode === 'signin' ? 'register' : 'signin');
                    setGateError('');
                    setFormSuccess('');
                }}
            >
                {mode === 'signin' ? 'Need an account? Register' : 'Already have an account? Sign in'}
            </button>
        </form>
    );
}
