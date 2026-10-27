// Reviewed release notes for one tag: .github/release-notes/<tag>.md, copied
// from .github/release-notes/TEMPLATE.md and completed before publication.
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export const requiredSections = ['Known limitations', 'OS and runtime requirements', 'Test matrix', 'Security notes', 'SBOM scope'];
export function releaseNotesPath(tag) {
  if (!/^v\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(tag ?? '')) throw new Error('An exact version tag is required.');
  return `.github/release-notes/${tag}.md`;
}
export function validateReleaseNotes(text, tag) {
  if (!new RegExp(`^# Mesa ${escapeRegExp(tag)}\\s*$`, 'm').test(text)) throw new Error(`Release notes must start with "# Mesa ${tag}".`);
  const sections = text.split(/^## +/m).slice(1).map(part => {
    const [heading, ...body] = part.split('\n');
    return { heading: heading.trim(), body: body.join('\n').trim() };
  });
  for (const name of requiredSections) {
    const matches = sections.filter(section => section.heading === name);
    if (matches.length !== 1 || !matches[0].body) throw new Error(`Release notes need one non-empty "## ${name}" section.`);
  }
  if (/\bTBD\b|\bTODO\b|<!--/.test(text)) throw new Error('Release notes still contain template placeholders.');
  return true;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const tag = process.env.MESA_RELEASE_TAG;
    validateReleaseNotes(readFileSync(releaseNotesPath(tag), 'utf8'), tag);
    console.log(`Reviewed release notes present for ${tag}.`);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
