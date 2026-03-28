/**
 * URL users return to after clicking "verify email" in Firebase mail.
 * Must be an authorized domain in Firebase Console.
 */
export function getEmailVerificationContinueUrl() {
    const explicit = import.meta.env.VITE_AUTH_PUBLIC_URL;
    if (explicit && String(explicit).trim()) {
        return String(explicit).replace(/\/$/, '');
    }
    if (typeof window !== 'undefined') {
        return `${window.location.origin}${import.meta.env.BASE_URL}`.replace(/\/$/, '');
    }
    return '';
}
