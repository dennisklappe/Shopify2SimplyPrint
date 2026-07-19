// Simple encryption for storing SimplyPrint API keys
// Uses Web Crypto API available in Cloudflare Workers

const ALGORITHM = "AES-GCM";
const IV_LENGTH = 12;
const TAG_LENGTH = 128;

const MIN_KEY_LENGTH = 32;

async function getKey(secret: string): Promise<CryptoKey> {
  // Reject short keys rather than padding them out. Padding turned a typo or a
  // half-set variable into a weak-but-working key, silently, with no error.
  if (!secret || secret.length < MIN_KEY_LENGTH) {
    throw new Error(
      `ENCRYPTION_KEY must be at least ${MIN_KEY_LENGTH} characters (got ${secret?.length ?? 0}). ` +
        `Generate one with: openssl rand -hex 16`
    );
  }

  const encoder = new TextEncoder();
  const keyData = encoder.encode(secret.slice(0, 32));

  return crypto.subtle.importKey("raw", keyData, { name: ALGORITHM }, false, [
    "encrypt",
    "decrypt",
  ]);
}

export async function encrypt(
  plaintext: string,
  secret: string
): Promise<string> {
  const key = await getKey(secret);
  const encoder = new TextEncoder();
  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));

  const encrypted = await crypto.subtle.encrypt(
    { name: ALGORITHM, iv, tagLength: TAG_LENGTH },
    key,
    encoder.encode(plaintext)
  );

  // Combine IV + encrypted data and encode as base64
  const combined = new Uint8Array(iv.length + encrypted.byteLength);
  combined.set(iv);
  combined.set(new Uint8Array(encrypted), iv.length);

  return btoa(String.fromCharCode(...combined));
}

export async function decrypt(
  ciphertext: string,
  secret: string
): Promise<string> {
  const key = await getKey(secret);
  const decoder = new TextDecoder();

  // Decode from base64
  const combined = new Uint8Array(
    atob(ciphertext)
      .split("")
      .map((c) => c.charCodeAt(0))
  );

  // Extract IV and encrypted data
  const iv = combined.slice(0, IV_LENGTH);
  const encrypted = combined.slice(IV_LENGTH);

  const decrypted = await crypto.subtle.decrypt(
    { name: ALGORITHM, iv, tagLength: TAG_LENGTH },
    key,
    encrypted
  );

  return decoder.decode(decrypted);
}
