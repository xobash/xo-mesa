// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAppStore } from './store';
import { backgroundWork } from './lib/backgroundWorkGovernor';
import { buildResearchContext, buildResearchPrompt, DEFAULT_DEEP_RESEARCH_LIMITS } from './lib/deepResearch';
const boundary = vi.hoisted(() => ({
    handlers: new Map<string, (event: {
        payload: unknown;
    }) => void>(),
    invoke: vi.fn(async (_name: string, _args?: unknown): Promise<unknown> => undefined),
    scan: vi.fn(async (_root: string): Promise<unknown[]> => []),
    create: vi.fn(async () => undefined),
    writeArchive: vi.fn(async () => undefined),
    read: vi.fn(async () => ''),
    restart: vi.fn(async () => undefined),
    stat: vi.fn(async (_path: string): Promise<unknown> => ({ size: 1 })),
}));
vi.mock('@tauri-apps/api/core', async (original) => ({ ...await original<object>(), invoke: boundary.invoke }));
vi.mock('@tauri-apps/plugin-fs', async (original) => ({ ...await original<object>(), stat: boundary.stat }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async (name: string, fn: (event: {
        payload: unknown;
    }) => void) => { boundary.handlers.set(name, fn); return () => boundary.handlers.delete(name); }) }));
vi.mock('./lib/vault', async (original) => ({ ...await original<object>(), IN_TAURI: true, scanVault: boundary.scan, createNote: boundary.create, writeVaultTextFile: boundary.writeArchive, readNote: boundary.read }));
vi.mock('./lib/piSessionBridge', () => ({ getPiSessionSnapshot: () => ({ sessionId: 'pi-proof' }), requestSharedPiRestart: boundary.restart }));
const initial = useAppStore.getState();
const depth = { rounds: 1, subQuestions: 2, maxSources: 8, maxGeneratedNotes: 2 };
const file = (root: string, relPath: string) => ({ path: `${root}/${relPath}`, relPath, name: relPath.slice(0, -3), ext: 'md', isMarkdown: true });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => resolve = r); return { promise, resolve }; }
function result() { const context = buildResearchContext({ query: 'test', activePath: null, selectedPaths: [], files: [], notes: {}, content: {}, limits: DEFAULT_DEEP_RESEARCH_LIMITS }); return JSON.parse(buildResearchPrompt({ runId: 'proof', query: 'test', folder: 'Research', context, depth }).match(/```json\n([\s\S]+?)\n```/)![1]); }
function changeActiveVault() { const run = useAppStore.getState().deepResearch; useAppStore.setState({ vaultPath: '/new-vault', deepResearch: run ? { ...run, phase: 'cancelled', changeSet: null } : null, files: [file('/new-vault', 'Research/Report.md')], notes: {}, contentCache: { 'Research/Report.md': 'new vault content' }, activePath: 'Research/Report.md', content: 'new vault content', openFile: vi.fn(async () => undefined) }); }
beforeEach(() => { vi.useFakeTimers(); backgroundWork.resetForTests(); boundary.handlers.clear(); boundary.invoke.mockReset(); boundary.scan.mockReset(); boundary.create.mockReset(); boundary.writeArchive.mockReset(); boundary.read.mockReset(); boundary.stat.mockReset(); useAppStore.setState({ ...initial, vaultPath: '/old-vault', files: [], notes: {}, contentCache: {}, deepResearch: null }); });
afterEach(async () => { await useAppStore.getState().cancelDeepResearch(); useAppStore.getState().discardDeepResearch(); useAppStore.setState(initial); backgroundWork.resetForTests(); vi.clearAllTimers(); vi.useRealTimers(); });
describe('Actual store Research async lifecycle boundaries, mocked I/O', () => {
    it('cancels a queued research context build before it can submit to Pi', async () => {
        backgroundWork.noteInteraction('typing');
        const start = useAppStore.getState().startDeepResearch('test question', { depth, piSurfaceAvailable: true });
        await vi.advanceTimersByTimeAsync(0);
        expect(useAppStore.getState().deepResearch?.launchStage).toBe('preparing');
        await useAppStore.getState().cancelDeepResearch();
        await start;
        await vi.advanceTimersByTimeAsync(500);
        expect(useAppStore.getState().deepResearch?.phase).toBe('cancelled');
        expect(boundary.invoke.mock.calls.filter(([name]) => name === 'terminal_write')).toHaveLength(1);
        expect(boundary.invoke.mock.calls.some(([name, args]) => name === 'terminal_write' && (args as { input?: string }).input !== '\u0003')).toBe(false);
    });

    it('must not merge completed old research after switching vault during apply rescan', async () => {
        const scan = deferred<unknown[]>();
        boundary.scan.mockReturnValue(scan.promise);
        const op = { kind: 'create' as const, relPath: 'Research/Report.md', title: 'Report', content: 'old research content' };
        useAppStore.setState({ deepResearch: { runId: 'proof-run', vaultRoot: '/old-vault', vaultGeneration: 0, phase: 'review', changeSet: { ops: [op], folder: 'Research', reportRelPath: op.relPath, createdRelPaths: [op.relPath], updatedRelPaths: [], skippedDuplicates: [] } } as never });
        const apply = useAppStore.getState().applyDeepResearch();
        await vi.advanceTimersByTimeAsync(0);
        // Reviewed apply loads its side-effect driver lazily before the first
        // filesystem call.
        await vi.dynamicImportSettled();
        expect(boundary.create).toHaveBeenCalledOnce();
        expect(boundary.scan).toHaveBeenCalledWith('/old-vault');
        changeActiveVault();
        scan.resolve([]);
        await apply;
        expect(useAppStore.getState().contentCache['Research/Report.md']).toBe('new vault content');
        expect(useAppStore.getState().openFile).not.toHaveBeenCalled();
    });
    it('must not start an archive write when its page fetch finishes after a vault switch', async () => {
        const fetch = deferred<unknown>();
        boundary.invoke.mockImplementation(async (name) => name === 'browse_fetch' ? fetch.promise : undefined);
        const start = useAppStore.getState().startDeepResearch('test question', { depth, piSurfaceAvailable: true });
        await vi.advanceTimersByTimeAsync(200);
        await start;
        const runId = useAppStore.getState().deepResearch!.runId;
        boundary.handlers.get('mesa://browse')!({ payload: 'https://example.com/page' });
        boundary.handlers.get('mesa://deep-research')!({ payload: { runId, kind: 'finish', requestId: 'finish-proof', result: result() } });
        await vi.advanceTimersByTimeAsync(0);
        expect(useAppStore.getState().deepResearch?.phase).toBe('review');
        expect(boundary.invoke.mock.calls.some(([name]) => name === 'browse_fetch')).toBe(true);
        changeActiveVault();
        fetch.resolve({ finalUrl: 'https://example.com/page', contentType: 'text/html', body: '<html><body>Evidence</body></html>' });
        await vi.advanceTimersByTimeAsync(0);
        expect(boundary.writeArchive).not.toHaveBeenCalled();
    });
    it('must not register an old archive when its text read finishes after a vault switch', async () => {
        const text = deferred<string>();
        boundary.read.mockReturnValue(text.promise);
        boundary.invoke.mockImplementation(async (name) => name === 'browse_fetch' ? { finalUrl: 'https://example.com/page', contentType: 'text/html', body: '<html><body>Evidence</body></html>' } : undefined);
        const start = useAppStore.getState().startDeepResearch('test question', { depth, piSurfaceAvailable: true });
        await vi.advanceTimersByTimeAsync(200);
        await start;
        const runId = useAppStore.getState().deepResearch!.runId;
        boundary.handlers.get('mesa://browse')!({ payload: 'https://example.com/page' });
        boundary.handlers.get('mesa://deep-research')!({ payload: { runId, kind: 'finish', requestId: 'register-proof', result: result() } });
        await vi.advanceTimersByTimeAsync(0);
        expect(boundary.writeArchive).toHaveBeenCalledOnce();
        expect(boundary.read).toHaveBeenCalledOnce();
        changeActiveVault();
        text.resolve('<html><body>Evidence</body></html>');
        await vi.advanceTimersByTimeAsync(0);
        expect(useAppStore.getState().files.every(file => file.path.startsWith('/new-vault/'))).toBe(true);
    });
    it.each(['review', 'applying', 'done', 'cancelled', 'error', 'discarded', 'replaced'] as const)(
        'only archives an accepted, current run while phase is %s',
        async (phase) => {
            const fetch = deferred<unknown>();
            boundary.invoke.mockImplementation(async name => name === 'browse_fetch' ? fetch.promise : undefined);
            const start = useAppStore.getState().startDeepResearch('test question', { depth, piSurfaceAvailable: true });
            await vi.advanceTimersByTimeAsync(200);
            await start;
            const runId = useAppStore.getState().deepResearch!.runId;
            boundary.handlers.get('mesa://browse')!({ payload: 'https://example.com/page' });
            boundary.handlers.get('mesa://deep-research')!({
                payload: { runId, kind: 'finish', requestId: 'phase-proof', result: result() },
            });
            await vi.advanceTimersByTimeAsync(0);
            const run = useAppStore.getState().deepResearch!;
            if (phase === 'discarded') {
                useAppStore.getState().discardDeepResearch();
            } else if (phase === 'replaced') {
                useAppStore.setState({ deepResearch: { ...run, runId: 'replacement' } });
            } else {
                useAppStore.setState({ deepResearch: { ...run, phase } });
            }
            fetch.resolve({ finalUrl: 'https://example.com/page', contentType: 'text/html', body: '<html><body>Evidence</body></html>' });
            await vi.advanceTimersByTimeAsync(0);
            const accepted = ['review', 'applying', 'done'].includes(phase);
            expect(boundary.writeArchive).toHaveBeenCalledTimes(accepted ? 1 : 0);
            if (accepted) {
                expect(useAppStore.getState().deepResearch?.sources[0].archiveStatus).toBe('saved');
                expect(useAppStore.getState().files).toHaveLength(1);
            }
        }
    );

});
