export function matchesStorageSha256(storageSha256: string, expectedHex: string) {
  const normalized = storageSha256.trim();
  if (/^[a-f0-9]{64}$/i.test(normalized)) {
    return normalized.toLowerCase() === expectedHex;
  }
  if (!/^[A-Za-z0-9+/]{43}=$/.test(normalized)) return false;

  // Convex storage metadata has returned both documented hex and base64 digests
  // across runtimes. Compare the decoded bytes so either representation is safe.
  try {
    const decoded = atob(normalized);
    if (decoded.length !== 32) return false;
    for (let index = 0; index < decoded.length; index += 1) {
      const expectedByte = Number.parseInt(expectedHex.slice(index * 2, index * 2 + 2), 16);
      if (decoded.charCodeAt(index) !== expectedByte) return false;
    }
    return true;
  } catch {
    return false;
  }
}
