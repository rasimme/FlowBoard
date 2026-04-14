import { useState } from 'react';
import { Button, Badge, Input, Modal } from '../components/index.js';

function Section({ title, children }) {
  return (
    <div className="mb-8">
      <h2 className="text-lg font-semibold text-text-strong mb-4 border-b border-border pb-2">
        {title}
      </h2>
      <div className="flex flex-wrap items-start gap-3">
        {children}
      </div>
    </div>
  );
}

function Card({ title, children }) {
  return (
    <div className="bg-card border border-border rounded-md p-4 min-w-[200px]">
      {title && <div className="text-xs font-semibold uppercase tracking-wider text-muted mb-3">{title}</div>}
      <div className="flex flex-wrap items-center gap-2">
        {children}
      </div>
    </div>
  );
}

export default function DesignTest() {
  const [modalOpen, setModalOpen] = useState(false);
  const [inputValue, setInputValue] = useState('');

  return (
    <div className="p-6 max-w-4xl mx-auto text-text">
      <h1 className="text-2xl font-bold text-text-strong mb-1">Design System — Kitchen Sink</h1>
      <p className="text-sm text-muted mb-8">Visual verification of all atoms against OpenClaw Gateway parity.</p>

      {/* ── Buttons ─────────────────────────────────── */}
      <Section title="Buttons — Variants">
        <Card title="Accent (default)">
          <Button size="sm">Small</Button>
          <Button size="md">Medium</Button>
          <Button size="lg">Large</Button>
        </Card>
        <Card title="Secondary">
          <Button variant="secondary" size="sm">Small</Button>
          <Button variant="secondary" size="md">Medium</Button>
        </Card>
        <Card title="Danger">
          <Button variant="danger" size="sm">Delete</Button>
          <Button variant="danger" size="md">Remove</Button>
        </Card>
        <Card title="Ghost">
          <Button variant="ghost" size="sm">Cancel</Button>
          <Button variant="ghost" size="md">Dismiss</Button>
        </Card>
      </Section>

      <Section title="Buttons — Icon (36x36)">
        <Card>
          <Button size="icon" variant="ghost" aria-label="Close">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
          </Button>
          <Button size="icon" variant="ghost" aria-label="Settings">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/></svg>
          </Button>
          <Button size="icon" variant="accent" aria-label="Add">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h14"/><path d="M12 5v14"/></svg>
          </Button>
        </Card>
      </Section>

      <Section title="Buttons — States">
        <Card>
          <Button disabled>Disabled</Button>
          <Button variant="ghost" disabled>Ghost Disabled</Button>
          <Button variant="danger" disabled>Danger Disabled</Button>
        </Card>
      </Section>

      {/* ── Badges ──────────────────────────────────── */}
      <Section title="Badges">
        <Card>
          <Badge>Default</Badge>
          <Badge variant="accent">Accent</Badge>
          <Badge variant="success">Success</Badge>
          <Badge variant="warning">Warning</Badge>
          <Badge variant="danger">Danger</Badge>
          <Badge variant="info">Info</Badge>
        </Card>
      </Section>

      {/* ── Inputs ──────────────────────────────────── */}
      <Section title="Inputs">
        <Card title="Default">
          <Input placeholder="Type something..." value={inputValue} onChange={(e) => setInputValue(e.target.value)} />
        </Card>
        <Card title="Disabled">
          <Input placeholder="Disabled input" disabled />
        </Card>
        <Card title="With value">
          <Input value="Pre-filled value" readOnly />
        </Card>
      </Section>

      {/* ── Modal ───────────────────────────────────── */}
      <Section title="Modal">
        <Card>
          <Button onClick={() => setModalOpen(true)}>Open Modal</Button>
        </Card>
      </Section>

      <Modal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        title="Confirm Action"
        actions={
          <>
            <Button variant="ghost" onClick={() => setModalOpen(false)}>Cancel</Button>
            <Button variant="danger" onClick={() => setModalOpen(false)}>Delete</Button>
          </>
        }
      >
        <p className="m-0">Are you sure you want to delete this item? This action cannot be undone.</p>
      </Modal>

      {/* ── Color Palette ───────────────────────────── */}
      <Section title="Color Palette">
        <div className="grid grid-cols-5 gap-2 w-full">
          {[
            ['bg-bg', 'BG #12141a'],
            ['bg-bg-elevated', 'Elevated #1a1d25'],
            ['bg-bg-hover', 'Hover #262a35'],
            ['bg-card', 'Card #181b22'],
            ['bg-accent', 'Accent #ff5c5c'],
            ['bg-accent-hover', 'Accent Hover #ff7070'],
            ['bg-accent-2', 'Accent-2 #14b8a6'],
            ['bg-ok', 'OK #22c55e'],
            ['bg-warn', 'Warn #f59e0b'],
            ['bg-danger', 'Danger #ef4444'],
            ['bg-info', 'Info #3b82f6'],
            ['bg-muted', 'Muted #71717a'],
            ['bg-border', 'Border #27272a'],
            ['bg-border-strong', 'Border Strong #3f3f46'],
          ].map(([bg, label]) => (
            <div key={bg} className="flex flex-col items-center gap-1">
              <div className={`${bg} w-12 h-12 rounded-md border border-border-strong`} />
              <span className="text-[10px] text-muted text-center leading-tight">{label}</span>
            </div>
          ))}
        </div>
      </Section>

      {/* ── Typography ──────────────────────────────── */}
      <Section title="Typography">
        <div className="flex flex-col gap-2 w-full">
          <div className="text-2xl font-bold text-text-strong font-sans">Heading — Space Grotesk Bold</div>
          <div className="text-base font-medium text-text font-sans">Body — Space Grotesk Medium</div>
          <div className="text-sm text-muted font-sans">Muted — Space Grotesk Regular</div>
          <div className="text-sm font-mono text-accent-2">Mono — JetBrains Mono</div>
        </div>
      </Section>

      {/* ── Shadows & Focus ─────────────────────────── */}
      <Section title="Shadows and Focus Rings">
        <Card title="shadow-card">
          <div className="bg-card border border-border rounded-md p-4 shadow-card text-sm text-text">
            Card shadow (popover style)
          </div>
        </Card>
        <Card title="focus-accent ring">
          <div className="bg-card border border-border rounded-md p-4 shadow-focus-accent text-sm text-text">
            Accent focus ring (color-mix)
          </div>
        </Card>
        <Card title="focus-danger ring">
          <div className="bg-card border border-border rounded-md p-4 shadow-focus-danger text-sm text-text">
            Danger focus ring (color-mix)
          </div>
        </Card>
      </Section>
    </div>
  );
}
