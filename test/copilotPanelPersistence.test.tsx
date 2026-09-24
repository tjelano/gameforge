// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { useState, useEffect } from 'react';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { CopilotPanel } from '@/app/components/CopilotPanel';

const ACTIVE_CONVERSATION_KEY = 'gameforge-copilot-active-conversation-id';

let mockUser: { id: string; name: string; isAdmin: boolean } | null = null;

vi.mock('next/navigation', () => ({
  usePathname: () => '/dashboard',
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

// The real useCurrentUser resolves `user` asynchronously (its own fetch, inside
// a useEffect) -- `user` is `null` on the very first render and only becomes
// truthy after a later microtask. That async gap is exactly what the bug this
// file guards against depends on: a naive mock that returns `user` truthy
// synchronously from render 1 cannot reproduce it (every effect fires in the
// same batch, before anything async has a chance to race). Mimicking the real
// timing here, not just the real shape.
vi.mock('@/lib/hooks/useCurrentUser', () => ({
  useCurrentUser: () => {
    const [state, setState] = useState<{ user: typeof mockUser; loading: boolean }>({ user: null, loading: true });
    useEffect(() => {
      Promise.resolve().then(() => setState({ user: mockUser, loading: false }));
    }, []);
    return state;
  },
}));

beforeEach(() => {
  mockUser = { id: 'u1', name: 'Alice', isAdmin: false };
  localStorage.clear();
  // jsdom doesn't implement scrollIntoView at all -- this file is the first
  // to actually open the panel (rendering the real DOM node CopilotPanel's
  // own scroll-to-bottom effect targets), which surfaces the gap.
  Element.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  localStorage.clear();
  mockUser = null;
});

function stubFetch(conversationBody: unknown) {
  vi.stubGlobal('fetch', vi.fn((url: string) => {
    if (url.includes('/api/settings/ollama/models')) {
      return Promise.resolve({ json: () => Promise.resolve({ success: true, data: { models: [], host: '' } }) });
    }
    if (url.includes('/api/copilot/conversations/')) {
      return Promise.resolve({ json: () => Promise.resolve(conversationBody) });
    }
    return Promise.resolve({ json: () => Promise.resolve({ success: false, error: 'unexpected URL in test' }) });
  }));
}

async function openPanel() {
  // The component renders nothing at all until the mocked useCurrentUser's
  // async resolution completes (matching the real hook), so the toggle
  // button itself doesn't exist yet on the very first render.
  const toggle = await screen.findByLabelText('Toggle GameForge copilot');
  fireEvent.click(toggle);
  await waitFor(() => expect(screen.getByPlaceholderText('Ask the copilot…')).toBeTruthy());
}

describe('CopilotPanel conversation persistence', () => {
  it('auto-resumes the conversation stored from a previous session on mount', async () => {
    localStorage.setItem(ACTIVE_CONVERSATION_KEY, 'conv-1');
    stubFetch({
      success: true,
      data: { id: 'conv-1', title: 'x', messages: [{ id: 'm1', role: 'assistant', content: 'Welcome back' }] },
    });

    render(<CopilotPanel />);
    await openPanel();

    await waitFor(() => expect(screen.getByText('Welcome back')).toBeTruthy());
  });

  it('does not attempt to load anything when no conversation was previously stored', async () => {
    stubFetch({ success: true, data: { id: 'conv-1', title: 'x', messages: [] } });

    render(<CopilotPanel />);
    await openPanel();

    expect(screen.getByText(/Ask about any GameForge feature/)).toBeTruthy();
    expect(vi.mocked(fetch)).not.toHaveBeenCalledWith(expect.stringContaining('/api/copilot/conversations/'));
  });

  it('persists the conversation id to localStorage once a conversation loads, and clears it on New chat', async () => {
    localStorage.setItem(ACTIVE_CONVERSATION_KEY, 'conv-1');
    stubFetch({
      success: true,
      data: { id: 'conv-1', title: 'x', messages: [{ id: 'm1', role: 'assistant', content: 'hi' }] },
    });

    render(<CopilotPanel />);
    await openPanel();
    await waitFor(() => expect(screen.getByText('hi')).toBeTruthy());
    expect(localStorage.getItem(ACTIVE_CONVERSATION_KEY)).toBe('conv-1');

    fireEvent.click(screen.getByRole('button', { name: 'New chat' }));
    expect(localStorage.getItem(ACTIVE_CONVERSATION_KEY)).toBeNull();
  });

  it('a genuinely fresh mount (simulating a real page reload) can still resume from what an earlier, separate mount persisted', async () => {
    const conversationId = 'conv-from-earlier-session';
    vi.stubGlobal('fetch', vi.fn((url: string) => {
      if (url.includes('/api/settings/ollama/models')) {
        return Promise.resolve({ json: () => Promise.resolve({ success: true, data: { models: [], host: '' } }) });
      }
      if (url === '/api/copilot/message') {
        return Promise.resolve({
          json: () => Promise.resolve({ success: true, data: { conversationId, reply: { text: 'first reply' } } }),
        });
      }
      if (url.includes(`/api/copilot/conversations/${conversationId}`)) {
        return Promise.resolve({
          json: () => Promise.resolve({
            success: true,
            data: {
              id: conversationId,
              title: 'x',
              messages: [
                { id: 'm1', role: 'user', content: 'hello' },
                { id: 'm2', role: 'assistant', content: 'first reply' },
              ],
            },
          }),
        });
      }
      return Promise.resolve({ json: () => Promise.resolve({ success: false, error: 'unexpected URL in test' }) });
    }));

    // First "session": establish a real conversation via handleSend (not
    // pre-seeded localStorage) so the persisted id comes from the same code
    // path a real user hits.
    const first = render(<CopilotPanel />);
    await openPanel();
    fireEvent.change(screen.getByPlaceholderText('Ask the copilot…'), { target: { value: 'hello' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(screen.getByText('first reply')).toBeTruthy());
    expect(localStorage.getItem(ACTIVE_CONVERSATION_KEY)).toBe(conversationId);

    // Simulate a real page reload: fully unmount the old instance and mount
    // an entirely new one, with no in-memory state shared between them --
    // only localStorage carries over, exactly like a browser refresh. This
    // is the scenario the original bug broke: a reactive "persist on
    // conversationId change" effect fired on the new instance's own first
    // render (conversationId still its initial null) and wiped the value
    // before the async user-driven resume effect got a chance to read it.
    first.unmount();
    cleanup();

    render(<CopilotPanel />);
    await openPanel();

    await waitFor(() => expect(screen.getByText('hello')).toBeTruthy());
    expect(screen.getByText('first reply')).toBeTruthy();
  });
});
