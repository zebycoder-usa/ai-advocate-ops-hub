// The left sidebar.
//
// It used to render all thirteen views as identical pills over two rows, giving
// a reference table the same visual weight as the screen people use fifty times
// a day. The sidebar keeps every screen visible but groups them by what they are
// for, so a new starter can see the whole app without opening a menu.
import { describe, it, expect, beforeEach } from 'vitest';
import { loadApp } from './loadApp.js';

let app, doc, w;
beforeEach(() => {
  app = loadApp(); doc = app.doc; w = app.window;
  // boot() only runs once the seat gate is passed, so a test window never has a
  // nav unless we build it. That is also why no earlier test exercised it.
  w.initNav();
});

const items = () => Array.from(doc.querySelectorAll('#nav button[data-nav]'));
const heads = () => Array.from(doc.querySelectorAll('#nav .side-head'));
const names = () => items().map((b) => b.getAttribute('data-nav'));
const activeView = () =>
  (Array.from(doc.querySelectorAll('.view')).find((v) => v.classList.contains('on')) || {})
    .getAttribute?.('data-view');

describe('every screen is visible at once', () => {
  it('shows all twelve views, none hidden behind a menu', () => {
    expect(items()).toHaveLength(w.VIEWS.length);
  });

  it('every view in VIEWS has a button', () => {
    const have = new Set(names());
    w.VIEWS.forEach(([name]) => expect(have.has(name)).toBe(true));
  });

  it('no button points at a view that does not exist', () => {
    names().forEach((n) => expect(doc.querySelector(`.view[data-view="${n}"]`)).not.toBeNull());
  });

  it('every button has a readable label', () => {
    items().forEach((b) => expect(b.textContent.trim().length).toBeGreaterThan(0));
  });

  it('opens on Home', () => {
    expect(activeView()).toBe('command');
  });
});

describe('grouped by what each screen is for', () => {
  it('has a heading for every section', () => {
    expect(heads()).toHaveLength(w.NAV_SECTIONS.length);
  });

  it('the headings read as plain English, not as jargon', () => {
    expect(heads().map((h) => h.textContent)).toEqual(['Work', 'The record', 'How we work', 'Help']);
  });

  it('the daily loop comes first', () => {
    expect(names().slice(0, 3)).toEqual(['command', 'evaluate', 'jobs']);
  });

  it('CL Score is gone, because scoring now happens inside Propose', () => {
    expect(names()).not.toContain('clscore');
    expect(doc.querySelector('.view[data-view="clscore"]')).toBeNull();
  });

  it('reference material is grouped away from the work', () => {
    const howWeWork = w.NAV_SECTIONS.find((s) => s.label === 'How we work').items;
    expect(howWeWork).toContain('scoring');
    expect(howWeWork).toContain('rules');
    expect(howWeWork).toContain('guide');
  });

  it('lists no screen twice', () => {
    expect(new Set(names()).size).toBe(names().length);
  });
});

describe('you can always tell where you are', () => {
  it('highlights the screen you are on', () => {
    w.go('jobs');
    const on = items().filter((b) => b.classList.contains('on'));
    expect(on).toHaveLength(1);
    expect(on[0].getAttribute('data-nav')).toBe('jobs');
  });

  it('only ever one thing looks selected', () => {
    ['sessions', 'rules', 'evaluate', 'ai'].forEach((v) => {
      w.go(v);
      expect(items().filter((b) => b.classList.contains('on'))).toHaveLength(1);
    });
  });

  it('moving between screens clears the previous highlight', () => {
    w.go('rules');
    w.go('evaluate');
    const on = items().filter((b) => b.classList.contains('on'));
    expect(on[0].getAttribute('data-nav')).toBe('evaluate');
  });
});

describe('clicking a sidebar item switches the screen', () => {
  it('shows the view it names', () => {
    doc.querySelector('#nav button[data-nav="scoring"]').click();
    expect(activeView()).toBe('scoring');
  });

  it('shows exactly one view at a time', () => {
    doc.querySelector('#nav button[data-nav="rules"]').click();
    expect(doc.querySelectorAll('.view.on')).toHaveLength(1);
  });

  it('every single item actually opens its screen', () => {
    // The check that would have caught a renamed or mistyped data-view.
    names().forEach((n) => {
      doc.querySelector(`#nav button[data-nav="${n}"]`).click();
      expect(activeView()).toBe(n);
    });
  });
});

describe('go() works however it is called', () => {
  it('switches the view from a bare name, with no button argument', () => {
    w.go('guide');
    expect(activeView()).toBe('guide');
  });

  it('still accepts a second argument, so older call sites do not break', () => {
    expect(() => w.go('rules', doc.querySelector('#nav button'))).not.toThrow();
    expect(activeView()).toBe('rules');
  });

  it('an unknown view name does not throw or empty the sidebar', () => {
    expect(() => w.go('does-not-exist')).not.toThrow();
    expect(items()).toHaveLength(w.VIEWS.length);
  });

  it('rebuilding the nav does not duplicate it', () => {
    w.initNav();
    w.initNav();
    expect(items()).toHaveLength(w.VIEWS.length);
  });
});
