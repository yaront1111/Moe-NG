import { execFile } from "node:child_process";

export interface ReleaseHeadSubject {
  readonly remoteUrl: string;
  readonly head: string;
  readonly sha: string;
}

/** Observe only the named remote ref; a stale durable push receipt cannot prove its live head. */
export function verifyReleaseHead(cwd: string, subject: ReleaseHeadSubject): Promise<boolean> {
  if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u.test(subject.sha)
    || subject.head.length === 0 || subject.remoteUrl.length === 0) return Promise.resolve(false);
  const ref = `refs/heads/${subject.head}`;
  return new Promise((resolve) => {
    execFile("git", ["ls-remote", "--exit-code", "--", subject.remoteUrl, ref], {
      cwd, encoding: "utf8", maxBuffer: 65_536, shell: false, timeout: 30_000, windowsHide: true,
    }, (error, stdout) => {
      if (error !== null) { resolve(false); return; }
      const rows = stdout.trim().split(/\r?\n/u);
      resolve(rows.length === 1 && rows[0] === `${subject.sha}\t${ref}`);
    });
  });
}
