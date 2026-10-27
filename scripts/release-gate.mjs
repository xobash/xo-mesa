import { pathToFileURL } from 'node:url';

export const requiredChecks = ['frontend', 'rust (ubuntu-latest)', 'rust (windows-latest)', 'rust (macos-latest)', 'rust-advisory', 'desktop (macos-latest, macos)', 'desktop (ubuntu-latest, linux)', 'desktop (windows-latest, windows)'];
export async function verifyRelease({ tag, sha, token, request = fetch }) {
  if (!/^v\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(tag ?? '') || !/^[a-f0-9]{40}$/.test(sha ?? '')) throw new Error('An exact version tag and commit are required.');
  const api = async path => {
    const response = await request(`https://api.github.com/repos/xobash/xo-mesa/${path}`, { headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`, 'X-GitHub-Api-Version': '2022-11-28' } });
    if (!response.ok) throw new Error(`Release metadata request failed (${response.status}).`);
    return response.json();
  };
  const ref = await api(`git/ref/tags/${encodeURIComponent(tag)}`);
  if (ref.object.type !== 'tag') throw new Error('Release requires a signed annotated tag.');
  const annotation = await api(`git/tags/${ref.object.sha}`);
  if (annotation.object.type !== 'commit' || annotation.object.sha !== sha || annotation.verification?.verified !== true) throw new Error('Release tag signature or target is invalid.');
  const manifest = await api(`contents/package.json?ref=${sha}`);
  const version = JSON.parse(Buffer.from(manifest.content, 'base64').toString('utf8')).version;
  if (tag !== `v${version}`) throw new Error('Tag does not match the exact commit package version.');
  const branch = await api('branches/main');
  if (!branch.protected) throw new Error('Main must remain protected.');
  const comparison = await api(`compare/${sha}...${branch.commit.sha}`);
  if (!['ahead', 'identical'].includes(comparison.status)) throw new Error('Release commit is not on main.');
  const runs = await api(`actions/workflows/build.yml/runs?head_sha=${sha}&status=success&per_page=100`);
  const run = runs.workflow_runs.find(run => run.head_sha === sha && run.head_branch === 'main' && run.event === 'push' && run.conclusion === 'success');
  if (!run) throw new Error('No successful main build for the exact release commit.');
  const jobs = await api(`actions/runs/${run.id}/jobs?per_page=100`);
  for (const name of requiredChecks) if (!jobs.jobs.some(job => job.name === name && job.conclusion === 'success')) throw new Error(`Missing successful release check: ${name}`);
  return { tag, commit: sha, buildRun: run.id };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { console.log(JSON.stringify(await verifyRelease({ tag: process.env.MESA_RELEASE_TAG, sha: process.env.MESA_RELEASE_SHA, token: process.env.GH_TOKEN }))); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
