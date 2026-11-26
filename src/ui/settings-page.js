// Inställningar: the few things worth changing from the room. The server says
// which settings there are and which values each may take
// (payload.settings, src/application/hub-settings.ts); a tap sends one of them.
(() => {
  'use strict';

  const root = document.querySelector(
    ".hub-page[data-page='installningar'] .settings-page",
  );

  const payload = () =>
    typeof latestPayload === 'undefined' ? undefined : latestPayload;

  let dom = null;
  let timer = 0;
  let quickMenuAttached = false;
  let builtFor = '';
  // A change under way, shown until the server's state agrees or it fails.
  const wanted = new Map();
  const sending = new Set();

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }
  function setText(node, value) {
    if (node.textContent !== value) node.textContent = value;
  }
  const offline = () => typeof isUnavailable === 'function' && isUnavailable();

  async function change(id, value) {
    if (sending.has(id) || offline()) return;
    sending.add(id);
    wanted.set(id, value);
    draw();
    try {
      const answer = await postJson(`${BASE_PATH}display-api/setting`, {
        id,
        value,
      });
      const data = payload();
      if (data && Array.isArray(answer?.settings))
        data.settings = answer.settings;
    } catch {
      if (typeof showToast === 'function')
        showToast('Det gick inte att spara.', 'error');
    } finally {
      sending.delete(id);
      wanted.delete(id);
      draw();
    }
  }

  function choiceCard(item) {
    const card = el('div', 'sp-card sp-choice');
    const value = el('strong', 'sp-value');
    value.setAttribute('aria-live', 'polite');
    const less = el('button', 'sp-step', '−');
    const more = el('button', 'sp-step', '+');
    for (const [button, label, step] of [
      [less, 'Minska', -1],
      [more, 'Öka', 1],
    ]) {
      button.type = 'button';
      button.setAttribute('aria-label', `${label}: ${item.label}`);
      button.addEventListener('click', () => {
        const next = button.choices?.[button.index + step];
        if (next) void change(item.id, next.value);
      });
    }
    card.append(el('span', 'sp-label', item.label), less, value, more);
    return {
      card,
      update(current, shown, busy) {
        const index = current.choices.findIndex((c) => c.value === shown);
        setText(value, current.choices[index]?.label ?? '');
        card.setAttribute('aria-busy', String(busy));
        for (const [button, end] of [
          [less, 0],
          [more, current.choices.length - 1],
        ]) {
          button.choices = current.choices;
          button.index = index;
          button.disabled = busy || offline() || index === end;
        }
      },
    };
  }

  function toggleCard(item) {
    const card = el('button', 'sp-card sp-toggle');
    card.type = 'button';
    card.setAttribute('role', 'switch');
    const knob = el('span', 'sp-switch');
    knob.setAttribute('aria-hidden', 'true');
    card.append(el('span', 'sp-label', item.label), knob);
    card.addEventListener('click', () => void change(item.id, !card.on));
    return {
      card,
      update(current, shown, busy) {
        card.on = shown === true;
        card.setAttribute('aria-checked', String(card.on));
        card.setAttribute('aria-busy', String(busy));
        card.disabled = busy || offline();
      },
    };
  }

  function ensureDom() {
    if (dom) return;
    const choices = el('section', 'sp-column sp-choices');
    const toggles = el('section', 'sp-column sp-toggles');
    const empty = el('p', 'sp-empty', 'Inga inställningar just nu.');
    root.replaceChildren(
      el('h1', 'sp-title', 'Inställningar'),
      choices,
      toggles,
      empty,
    );
    dom = { choices, toggles, empty, rows: new Map() };
  }

  function ensureQuickMenu() {
    if (quickMenuAttached || !globalThis.lugnQuickMenu?.attach) return;
    quickMenuAttached = true;
    globalThis.lugnQuickMenu.attach({
      id: 'installningar',
      root,
      handleTap: (event) => Boolean(event.target?.closest?.('.sp-card')),
    });
  }

  function draw() {
    if (!root) return;
    ensureDom();
    ensureQuickMenu();
    const list = payload()?.settings ?? [];
    const key = list.map((item) => `${item.id}:${item.kind}`).join('|');
    if (key !== builtFor) {
      builtFor = key;
      dom.rows = new Map(
        list.map((item) => [
          item.id,
          item.kind === 'toggle' ? toggleCard(item) : choiceCard(item),
        ]),
      );
      for (const [column, kind] of [
        [dom.choices, 'choice'],
        [dom.toggles, 'toggle'],
      ])
        column.replaceChildren(
          ...list
            .filter((item) => item.kind === kind)
            .map((item) => dom.rows.get(item.id).card),
        );
    }
    dom.empty.hidden = list.length > 0;
    for (const item of list)
      dom.rows
        .get(item.id)
        .update(
          item,
          wanted.has(item.id) ? wanted.get(item.id) : item.value,
          sending.has(item.id),
        );
  }

  function stop() {
    window.clearInterval(timer);
    timer = 0;
  }

  if (globalThis.lugnPages?.define) {
    globalThis.lugnPages.define('installningar', {
      prepare: draw,
      enter() {
        stop();
        draw();
        timer = window.setInterval(draw, 1000);
      },
      leave: stop,
      sleep: stop,
    });
  } else {
    draw();
  }
})();
