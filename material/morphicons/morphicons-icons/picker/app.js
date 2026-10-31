/* morphicons 图标选板
 *
 * 结构：一份全量索引（data/index.js，只含名字与尺寸）+ 每个图标集一个数据文件
 *       （data/s-<set>.js，含 SVG 内容），滚到哪一套才加载哪一套。
 * 渲染：虚拟滚动。容器高度按总行数撑开，只在 DOM 里保留视口内外的少量卡片。
 */
'use strict';

(() => {
  const DATA = window.MC_DATA;
  const $ = (id) => document.getElementById(id);
  const grid = $('grid');
  const spacer = $('spacer');
  const emptyEl = $('empty');
  const countEl = $('count');
  const resetBtn = $('reset');
  const qEl = $('q');
  const libEl = $('lib');
  const segEl = $('seg');
  const detail = $('detail');
  const toastEl = $('toast');

  if (!DATA) {
    countEl.textContent = '数据文件缺失，请先运行 build_picker.py';
    return;
  }

  const SETS = DATA.sets;

  // 几何尺寸必须与 styles.css 里的 .card 高度、留白一致
  const GAP = 8;
  const CARD_H = 88;
  const MIN_CARD = 92;
  const ROW_H = CARD_H + GAP;
  const OVERSCAN = 2; // 视口上下各多渲染几行，滚动时不出白

  const ICONS = DATA.icons.map((r) => {
    const set = SETS[r[0]];
    return {
      set: r[0],
      label: r[1],
      name: r[2],
      w: r[3],
      h: r[4],
      // 预拼接小写检索串，避免每次输入都重复字符串拼接
      key: `${r[1]} ${r[2]} ${r[0]} ${set.label}`.toLowerCase(),
    };
  });

  let view = ICONS; // 当前筛选结果
  let cols = 1;
  let colW = MIN_CARD;
  let rows = 0;
  let absTop = 0; // 网格距离文档顶部的距离，只在布局变化时重算
  let current = null; // 当前选中的图标记录
  let rafId = 0;
  const mounted = new Map(); // 视图索引 → 卡片元素
  const pending = new Map(); // 图标集 → 加载中的 Promise

  /* ── 数据按需加载 ─────────────────────────────────── */

  const bodyOf = (rec) => {
    const set = window.MC_SETS && window.MC_SETS[rec.set];
    const item = set && set[rec.label];
    return item ? item[3] : null;
  };

  function loadSet(key) {
    if (window.MC_SETS && window.MC_SETS[key]) return Promise.resolve();
    if (pending.has(key)) return pending.get(key);
    const task = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = `data/s-${key}.js`;
      s.onload = resolve;
      s.onerror = () => reject(new Error(`加载失败：${key}`));
      document.head.appendChild(s);
    });
    pending.set(key, task);
    return task;
  }

  /* ── 卡片 ─────────────────────────────────────────── */

  function paint(el, i) {
    const rec = view[i];
    const body = bodyOf(rec);
    const ico = el.firstElementChild;
    if (body == null) {
      ico.className = 'ico sk';
      ico.textContent = '';
      return;
    }
    ico.className = 'ico';
    ico.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${rec.w} ${rec.h}">${body}</svg>`;
  }

  function makeCard(i) {
    const rec = view[i];
    const el = document.createElement('button');
    el.type = 'button';
    el.className = 'card';
    el.dataset.i = String(i);
    el.title = `${rec.label} — ${SETS[rec.set].label}`;
    el.innerHTML = '<span class="ico sk"></span><span class="nm"></span>';
    el.lastElementChild.textContent = rec.label;
    if (current && current.set === rec.set && current.label === rec.label) el.classList.add('on');
    paint(el, i);
    return el;
  }

  function place(el, i) {
    el.style.width = `${colW}px`;
    const x = (i % cols) * (colW + GAP);
    const y = Math.floor(i / cols) * ROW_H;
    el.style.transform = `translate3d(${x}px, ${y}px, 0)`;
  }

  /* ── 虚拟滚动 ─────────────────────────────────────── */

  function measure() {
    const w = grid.clientWidth || spacer.clientWidth || 800;
    cols = Math.max(1, Math.floor((w + GAP) / (MIN_CARD + GAP)));
    colW = (w - GAP * (cols - 1)) / cols;
    rows = Math.ceil(view.length / cols);
    spacer.style.height = view.length ? `${rows * ROW_H - GAP}px` : '0px';
    absTop = spacer.getBoundingClientRect().top + window.scrollY;
  }

  function clearCards() {
    for (const el of mounted.values()) el.remove();
    mounted.clear();
  }

  function render() {
    if (!view.length) {
      clearCards();
      return;
    }
    const top = window.scrollY - absTop;
    const first = Math.max(0, Math.floor(top / ROW_H) - OVERSCAN);
    const last = Math.min(rows - 1, Math.floor((top + window.innerHeight) / ROW_H) + OVERSCAN);
    const from = first * cols;
    const to = Math.min(view.length, (last + 1) * cols);

    for (const [i, el] of mounted) {
      if (i < from || i >= to) {
        el.remove();
        mounted.delete(i);
      }
    }

    const frag = document.createDocumentFragment();
    const need = new Set();
    for (let i = from; i < to; i++) {
      let el = mounted.get(i);
      if (!el) {
        el = makeCard(i);
        mounted.set(i, el);
        frag.appendChild(el);
      }
      place(el, i);
      if (bodyOf(view[i]) == null) need.add(view[i].set);
    }
    if (frag.childNodes.length) grid.appendChild(frag);
    if (need.size) loadAll([...need]);
  }

  function schedule() {
    if (rafId) return;
    rafId = requestAnimationFrame(() => {
      rafId = 0;
      render();
    });
    // 后台标签页或某些无头环境里 rAF 可能一直不触发，用定时器兜底重绘一次
    clearTimeout(schedule.fallback);
    schedule.fallback = setTimeout(() => {
      if (!rafId) return;
      cancelAnimationFrame(rafId);
      rafId = 0;
      render();
    }, 150);
  }

  function loadAll(keys) {
    Promise.allSettled(keys.map(loadSet)).then((results) => {
      // 有失败就保留占位，不打断其它已加载的图标集
      if (results.some((r) => r.status === 'rejected')) console.warn('部分图标集加载失败', results);
      for (const [i, el] of mounted) paint(el, i);
    });
  }

  /* ── 筛选 ─────────────────────────────────────────── */

  let style = '';

  function apply() {
    // 空格分词，每个词都要命中，这样「tabler home」「lucide 箭头」都能用
    const tokens = qEl.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const lib = libEl.value;
    view = ICONS.filter((r) => {
      const s = SETS[r.set];
      return (!style || s.style === style)
        && (!lib || s.lib === lib)
        && tokens.every((t) => r.key.includes(t));
    });
    close();
    clearCards();
    if (window.scrollY > 0) window.scrollTo(0, 0);
    measure();
    render();
    const filtered = view.length !== ICONS.length;
    countEl.textContent = filtered
      ? `筛选出 ${view.length} 个图标，共 ${ICONS.length} 个`
      : `共 ${ICONS.length} 个图标 · ${Object.keys(SETS).length} 个图标集`;
    resetBtn.hidden = !filtered;
    emptyEl.hidden = view.length > 0;
  }

  /* ── 详情与复制 ───────────────────────────────────── */

  const svgOf = (rec) =>
    `<svg xmlns="http://www.w3.org/2000/svg" width="${rec.w}" height="${rec.h}" ` +
    `viewBox="0 0 ${rec.w} ${rec.h}">${bodyOf(rec)}</svg>`;

  // 把 SVG 的属性名转成 JSX 写法（stroke-width → strokeWidth），只动标签内的属性名，
  // 不会碰到路径数据里的负号。
  const camel = (name) => name.replace(/-([a-z])/g, (_, c) => c.toUpperCase());

  function jsxOf(svg) {
    return svg.replace(/<([a-zA-Z][\w-]*)([^>]*?)(\/?)>/g, (_, tag, attrs, selfClose) => {
      const fixed = attrs.replace(/(\s)([a-zA-Z][a-zA-Z0-9]*(?:-[a-zA-Z0-9]+)+)=/g,
        (_m, sp, name) => sp + camel(name) + '=');
      return `<${tag}${fixed}${selfClose ? ' />' : '>'}`;
    });
  }

  function pathsOf(rec) {
    const out = [];
    bodyOf(rec).replace(/\sd="([^"]+)"/g, (_, d) => {
      out.push(d);
      return _;
    });
    return out.join('\n');
  }

  function toast(text) {
    toastEl.textContent = text;
    toastEl.classList.add('show');
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => toastEl.classList.remove('show'), 1400);
  }

  async function copy(text) {
    if (!text) return toast('没有可复制的内容');
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // 本地 file:// 打开时剪贴板接口可能不可用，退回老办法
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.cssText = 'position:fixed;opacity:0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
    }
    toast('已复制');
  }

  function open(i) {
    const rec = view[i];
    const set = SETS[rec.set];
    current = rec;

    document.querySelectorAll('.card.on').forEach((el) => el.classList.remove('on'));
    const card = mounted.get(i);
    if (card) card.classList.add('on');

    $('dPrev').innerHTML =
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${rec.w} ${rec.h}">${bodyOf(rec)}</svg>`;
    $('dName').textContent = rec.label;
    const bits = [set.label, set.style === 'fill' ? '填充' : '线性', `${rec.w}×${rec.h}`, set.license];
    if (rec.name !== rec.label) bits.push(`上游名 ${rec.name}`);
    $('dMeta').textContent = bits.join(' · ');
    $('dFile').href = `../${set.dir}/${rec.label}.svg`;
    $('dFile').setAttribute('download', `${rec.label}.svg`);
    $('dCode').textContent = svgOf(rec);

    detail.hidden = false;
    document.body.classList.add('has-detail');
    measure();
    render();
  }

  function close() {
    if (detail.hidden) return;
    detail.hidden = true;
    document.body.classList.remove('has-detail');
    document.querySelectorAll('.card.on').forEach((el) => el.classList.remove('on'));
    current = null;
    measure();
    render();
  }

  /* ── 事件 ─────────────────────────────────────────── */

  // 图标库下拉
  const libs = new Map();
  for (const r of ICONS) {
    const s = SETS[r.set];
    const hit = libs.get(s.lib);
    if (hit) hit.n += 1;
    else libs.set(s.lib, { label: s.label, n: 1 });
  }
  libEl.innerHTML = '<option value="">全部图标库</option>'
    + [...libs].sort((a, b) => a[1].label.localeCompare(b[1].label))
      .map(([k, v]) => `<option value="${k}">${v.label} · ${v.n}</option>`).join('');

  let debounce = 0;
  qEl.addEventListener('input', () => {
    clearTimeout(debounce);
    debounce = setTimeout(apply, 70);
  });

  segEl.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-style]');
    if (!btn) return;
    style = btn.dataset.style;
    [...segEl.children].forEach((b) => b.classList.toggle('on', b === btn));
    apply();
  });

  libEl.addEventListener('change', apply);
  resetBtn.addEventListener('click', () => {
    qEl.value = '';
    libEl.value = '';
    style = '';
    [...segEl.children].forEach((b) => b.classList.toggle('on', b.dataset.style === ''));
    apply();
  });

  grid.addEventListener('click', (e) => {
    const card = e.target.closest('.card');
    if (card) open(Number(card.dataset.i));
  });

  $('close').addEventListener('click', close);

  detail.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-copy]');
    if (!btn || !current) return;
    const kind = btn.dataset.copy;
    if (kind === 'svg') copy(svgOf(current));
    else if (kind === 'jsx') copy(jsxOf(svgOf(current)));
    else copy(pathsOf(current));
  });

  document.addEventListener('keydown', (e) => {
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName);
    if (e.key === '/' && !typing) {
      e.preventDefault();
      qEl.focus();
      qEl.select();
    } else if (e.key === 'Escape') {
      if (!detail.hidden) close();
      else if (typing && qEl.value) {
        qEl.value = '';
        apply();
      }
    }
  });

  window.addEventListener('scroll', schedule, { passive: true });
  window.addEventListener('resize', () => {
    measure();
    render();
  });

  /* ── 启动 ─────────────────────────────────────────── */

  measure();
  render();
  apply();
})();
