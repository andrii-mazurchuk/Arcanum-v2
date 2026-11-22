// Pinned-Bun check (S-241): package.json's engines.bun is the reference pin, and the running Bun
// must equal it byte for byte. Run as a script (the check:bun step of the image build) it compares
// against Bun.version, so an image whose Bun is not the pinned one fails to build.

const EXACT = /^[0-9]+\.[0-9]+\.[0-9]+$/;

export function checkPinnedBun(
  packageJsonText: string,
  running: string,
): { ok: boolean; pinned: string | null; running: string } {
  let pinned: string | null = null;
  try {
    const pkg: unknown = JSON.parse(packageJsonText);
    const engines = (pkg as { engines?: unknown } | null)?.engines;
    const bun = (engines as { bun?: unknown } | null | undefined)?.bun;
    if (typeof bun === 'string') pinned = bun;
  } catch {
    pinned = null;
  }
  const ok = pinned !== null && EXACT.test(pinned) && pinned === running;
  return { ok, pinned, running };
}

if (import.meta.main) {
  const text = await Bun.file(new URL('../../package.json', import.meta.url)).text();
  const result = checkPinnedBun(text, Bun.version);
  console.log(`pinned ${result.pinned}, running ${result.running}`);
  process.exit(result.ok ? 0 : 1);
}
