// The navigation bar.
//
// It used to render all thirteen views as identical pills over two rows, giving
// a reference table the same weight as the screen people use fifty times a day.
// Four stay on the bar; the nine you look up rather than work in moved into
// "More". These tests exist so nothing silently becomes unreachable.
import { describe, it, expect, beforeEach } from 'vitest';
import { loadApp } from './loadApp.js';

let app, doc, w;
beforeEach(() => {
  app = loadApp(); doc = app.doc; w = app.window;
  // boot() only runs once the seat gate is passed, so a test window never has a
  // nav unless we build it. That is also why no earlier test ever exercised it.
  w.initNav();
});

const barButtons = () => Array.from(doc.querySelectorAll('#nav > button[data-nav]'));
const panelItems = () => Array.from(doc.querySelectorAll('#nav-more-panel .more-item'));
const activeView = () =>
  (Array.from(doc.querySelectorAll('.view')).find((v) => v.classList.contains('on')) || {})
    .getAttribute?.('data-view');

describe('the bar is short', () => {
  it('shows four primary items plus More, not thirteen', () => {
    expect(barButtons()).toHaveLength(4);
    expect(doc.getElementById('nav-more')).not.toBeNull();
  });

  it('the four are the things people actually do', () => {
    expect(barButtons().map((b) => b.getAttribute('data-nav')))
      .toEqual(['command', 'evaluate', 'jobs', 'clscore']);
  });

  it('opens on Home', () => {
    expect(activeView()).toBe('command');
  });
});

describe('nothing became unreachable', () => {
  it('every view is on the bar or in the More panel', () => {
    const reachable = new Set(
      barButtons().concat(panelItems()).map((b) => b.getAttribute('data-nav'))
    );
    w.VIEWS.forEach(([name]) => expect(reachable.has(name)).toBe(true));
  });

  it('the panel holds the other nine', () => {
    expect(panelItems()).toHaveLength(9);
  });

  it('the panel is grouped rather than one long list', () => {
    expect(doc.querySelectorAll('#nav-more-panel .more-head').length).toBeGreaterThanOrEqual(2);
  });

  it('every panel item has a readable label', () => {
    panelItems().forEach((b) => expect(b.textContent.trim().length).toBeGreaterThan(0));
  });
});

describe('you can always tell where you are', () => {
  it('a primary view highlights its own button', () => {
    w.go('jobs');
    const on = barButtons().filter((b) => b.classList.contains('on'));
    expect(on).toHaveLength(1);
    expect(on[0].getAttribute('data-nav')).toBe('jobs');
  });

  it('a view inside More renames the More button to that view', () => {
    // Otherwise the bar says "More" and the operator has lost track of the page
    // they are looking at.
    w.go('sessions');
    const more = doc.getElementById('nav-more');
    expect(more.textContent).toBe('Sign-ins');
    expect(more.classList.contains('on')).toBe(true);
  });

  it('going back to a primary view resets the More label', () => {
    w.go('sessions');
    w.go('evaluate');
    const more = doc.getElementById('nav-more');
    expect(more.textContent).toBe('More');
    expect(more.classList.contains('on')).toBe(false);
  });

  it('only ever one thing looks selected', () => {
    w.go('rules');
    const onCount = barButtons().filter((b) => b.classList.contains('on')).length
      + (doc.getElementById('nav-more').classList.contains('on') ? 1 : 0);
    expect(onCount).toBe(1);
  });
});

describe('go() works however it is called', () => {
  it('switches the view from a bare name, with no button argument', () => {
    w.go('scoring');
    expect(activeView()).toBe('scoring');
  });

  it('still accepts a second argument, so older call sites do not break', () => {
    expect(() => w.go('rules', doc.getElementById('nav-more'))).not.toThrow();
    expect(activeView()).toBe('rules');
  });

  it('an unknown view name does not throw or blank the bar', () => {
    expect(() => w.go('does-not-exist')).not.toThrow();
    expect(barButtons()).toHaveLength(4);
  });
});

describe('the More panel opens and closes', () => {
  it('starts closed', () => {
    expect(doc.getElementById('nav-more-panel').hidden).toBe(true);
  });

  it('opens on click and closes on a second click', () => {
    const more = doc.getElementById('nav-more');
    more.click();
    expect(doc.getElementById('nav-more-panel').hidden).toBe(false);
    more.click();
    expect(doc.getElementById('nav-more-panel').hidden).toBe(true);
  });

  it('closes when you pick something from it', () => {
    doc.getElementById('nav-more').click();
    panelItems()[0].click();
    expect(doc.getElementById('nav-more-panel').hidden).toBe(true);
  });

  it('closes on Escape, so it never strands the operator', () => {
    doc.getElementById('nav-more').click();
    doc.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape' }));
    expect(doc.getElementById('nav-more-panel').hidden).toBe(true);
  });

  it('reports its open state to screen readers', () => {
    const more = doc.getElementById('nav-more');
    expect(more.getAttribute('aria-expanded')).toBe('false');
    more.click();
    expect(more.getAttribute('aria-expanded')).toBe('true');
  });
});
