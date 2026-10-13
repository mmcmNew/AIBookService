// Проверка ПЛАНОВОЙ архитектуры: только схема, кода не нужно.
//  R1. Матрица слоёв на стрелках сценария (UI → только Домен, State только хранит, Data/Infra только с Доменом, ...).
//  R2. Владелец состояния: запись в кусок состояния только от его блока-владельца.
//  R3. Происхождение данных: блок ничего не получает, но пишет или вызывает — «данные появились из ниоткуда».
//  R4. Блок-схема блока согласована со сценарием: шаг, который читает/пишет/вызывает, имеет стрелку на сценарии, и наоборот.
//  R6. Нет циклов вызовов между отделами: начальник зовёт подчинённого, подчинённый отвечает результатом или событием.
//  R7. У хранилища или ресурса (Data/Infra) есть один ответственный отдел, и на сценарии с ним работает только он.
//  R8. Зоны: у зоны есть глава из этой же зоны; межзонные вызовы и записи только в главу зоны (чтение состояния разрешено).
//  R5. Шаг блок-схемы с данными (параллелограмм) обязан называть источник: ресурс/кусок состояния, блок, input или external.

export function lintPlan(model) {
  const issues = [], seen = new Set();
  const add = (sev, scenario, block, text) => { const k = sev + scenario + block + text; if (!seen.has(k)) { seen.add(k); issues.push({ sev, scenario, block, text }); } };
  const B = model.blocks, S = model.states || {};
  const title = (id) => B[id]?.title || id;
  const sources = (id) => [B[id]?.slice, ...(B[id]?.res || [])].filter(Boolean); // чем «является» блок: кусок состояния или ресурсы

  const ZR = model.zones || {};
  if (Object.keys(ZR).length) {
    for (const [zid, z] of Object.entries(ZR)) {
      if (!B[z.head]) add('err', '—', zid, `У зоны «${z.title}» не найден глава (${z.head})`);
      else if (B[z.head].zone !== zid) add('err', '—', z.head, `Глава зоны «${z.title}» («${B[z.head].title}») принадлежит другой зоне`);
    }
    for (const [id, b] of Object.entries(B)) if (!b.zone || !ZR[b.zone]) add('warn', '—', id, `Блок «${b.title}» не входит ни в одну зону`);
  }
  for (const sc of model.scenarios) {
    const E = sc.edges.map((e, i) => {
      const paired = sc.edges.findIndex((x) => x.from === e.to && x.to === e.from);
      const A = B[e.from], T = B[e.to];
      const kind = e.kind || (paired >= 0 && paired < i ? 'return' : A.layer === 'State' ? 'data' : T.layer === 'State' || T.layer === 'Data' ? 'write' : 'call');
      return { ...e, kind };
    });
    const ids = Object.keys(sc.cols);

    // R1, R2: слои и владельцы
    for (const e of E) {
      if (e.kind === 'return') continue;
      const A = B[e.from], T = B[e.to], name = `«${title(e.from)}» → «${title(e.to)}»`;
      if (A.layer === 'UI' && T.layer === 'State' && e.kind !== 'data') add('err', sc.id, e.from, `UI не пишет состояние: ${name}. Команда должна идти в Домен`);
      if (A.layer === 'UI' && (T.layer === 'Data' || T.layer === 'Infra')) add('err', sc.id, e.from, `UI не ходит в ${T.layer} напрямую: ${name}. Только через Домен`);
      if (A.layer === 'State' && e.kind !== 'data') add('err', sc.id, e.from, `State только хранит, ничего не вызывает и не пишет: ${name}`);
      if ((A.layer === 'Data' || A.layer === 'Infra') && T.layer !== 'Domain') add('err', sc.id, e.from, `${A.layer} общается только с Доменом: ${name}`);
      if (A.layer === 'Domain' && T.layer === 'UI') add('err', sc.id, e.from, `Домен не обращается к UI: ${name}. Данные идут через State, UI читает их оттуда`);
      if (T.layer === 'State' && e.kind === 'write' && T.slice) {
        const owner = S[T.slice]?.owner;
        if (owner && owner !== e.from) add('err', sc.id, e.from, `Запись в «${S[T.slice].title}» не от владельца «${title(owner)}»: ${name}. Нужно просить владельца командой`);
        if (!owner) add('warn', sc.id, e.to, `У состояния «${S[T.slice]?.title || T.slice}» нет владельца, а в него пишет «${title(e.from)}»`);
      }
    }

    // R8: межзонные обращения только в главу зоны
    if (Object.keys(ZR).length) for (const e of E) {
      if (e.kind === 'return') continue;
      const A = B[e.from], T = B[e.to];
      if (!A.zone || !T.zone || A.zone === T.zone) continue;
      if (A.layer === 'State' && e.kind === 'data') continue; // чтение состояния из любой зоны разрешено
      const head = ZR[T.zone]?.head;
      if (head !== e.to) add('err', sc.id, e.from, `Обращение в чужую зону не через главу: «${title(e.from)}» (${ZR[A.zone]?.title}) → «${title(e.to)}» (${ZR[T.zone]?.title}). Обращаться нужно к главе зоны «${title(head)}»`);
    }
    // R6: циклы вызовов (только прямые вызовы, возвраты и события не считаются)
    {
      const adj = {};
      for (const e of E) if (e.kind === 'call' && B[e.from].layer !== 'UI') (adj[e.from] ||= []).push(e.to);
      const state2 = {}, stack = [];
      const dfs = (u) => {
        state2[u] = 1; stack.push(u);
        for (const v of adj[u] || []) {
          if (state2[v] === 1) { const cyc = stack.slice(stack.indexOf(v)).concat(v); add('err', sc.id, v, 'Цикл вызовов: ' + cyc.map(title).join(' → ') + '. Подчинённый отвечает результатом или событием, а не зовёт начальника'); }
          else if (!state2[v]) dfs(v);
        }
        stack.pop(); state2[u] = 2;
      };
      for (const u of Object.keys(adj)) if (!state2[u]) dfs(u);
    }
    // R7: ответственный за хранилище/ресурс: на сценарии с ним работает только он
    for (const e of E) {
      if (e.kind === 'return') continue;
      const T = B[e.to];
      if (T.layer !== 'Data' && T.layer !== 'Infra') continue;
      for (const rid of T.res || []) {
        const owner = model.resources[rid]?.owner;
        if (owner && owner !== e.from && B[e.from].layer === 'Domain') add('err', sc.id, e.from, `С «${T.title}» работает не ответственный: «${title(e.from)}» вместо «${title(owner)}». Нужно просить ответственного`);
      }
    }

    // R3: данные из ниоткуда
    for (const id of ids) {
      const b = B[id];
      if (b.layer !== 'Domain') continue;
      const incoming = E.filter((e) => e.to === id), outgoing = E.filter((e) => e.from === id && e.kind !== 'return');
      if (outgoing.length && !incoming.length) add('warn', sc.id, id, `«${b.title}» ничего не получает (ни команды, ни данных), но пишет и вызывает: откуда у него данные?`);
      else if (outgoing.some((e) => B[e.to].layer === 'State' || B[e.to].layer === 'Data' || B[e.to].layer === 'Infra') && !incoming.some((e) => B[e.from].layer === 'State' || B[e.from].layer === 'Data' || e.kind === 'return' || B[e.from].layer === 'UI' || B[e.from].layer === 'Domain' || B[e.from].layer === 'Infra')) add('warn', sc.id, id, `«${b.title}» не получает данных ни от состояния, ни от хранилища`);
    }

    // R4: блок-схема блока и сценарий
    for (const id of ids) {
      const b = B[id], fl = b.flow && model.flows[b.flow];
      if (!fl) continue;
      const nodes = fl.nodes, linked = (other) => E.some((e) => (e.from === id && e.to === other) || (e.from === other && e.to === id));
      for (const n of nodes) {
        if (n.res) { // шаг читает/пишет ресурс или кусок состояния -> на сценарии должна быть стрелка к блоку, который им является
          const targets = Object.keys(B).filter((x) => x !== id && sources(x).includes(n.res));
          if (targets.length && !targets.some(linked)) add('warn', sc.id, id, `Шаг «${n.label}» ${n.rw === 'write' ? 'пишет' : 'читает'} «${S[n.res]?.title || model.resources[n.res]?.title || n.res}», но на сценарии нет стрелки между «${b.title}» и «${title(targets[0])}»`);
          if (!targets.length) add('warn', sc.id, id, `Шаг «${n.label}» использует «${S[n.res]?.title || n.res}», а на карте нет блока, который им является`);
        }
        if (n.block && B[n.block] && !linked(n.block)) add('warn', sc.id, id, `Шаг «${n.label}» обращается к «${title(n.block)}», но на сценарии нет стрелки`);
        // R5: данные без источника
        if (n.t === 'io' && !n.res && !n.block && !n.via) add('warn', sc.id, id, `Шаг «${n.label}» обрабатывает данные, но не указано откуда они (res, block, via: input или external)`);
      }
      const has = (pred) => nodes.some(pred);
      for (const e of E.filter((x) => x.to === id && x.kind === 'data')) { // данные приходят: есть ли шаг, который их читает
        const src = sources(e.from);
        if (src.length && !has((n) => src.includes(n.res))) add('warn', sc.id, id, `На сценарии данные приходят из «${title(e.from)}» («${e.label}»), но в блок-схеме «${b.title}» нет шага, который их читает`);
      }
      for (const e of E.filter((x) => x.from === id && (x.kind === 'write'))) { // блок пишет: есть ли шаг записи
        const src = sources(e.to);
        if (src.length && !has((n) => src.includes(n.res))) add('warn', sc.id, id, `На сценарии «${b.title}» пишет в «${title(e.to)}», но в блок-схеме нет шага записи`);
      }
      for (const e of E.filter((x) => x.from === id && x.kind === 'call' && B[x.to].layer !== 'State')) { // блок вызывает: есть ли шаг вызова
        if (!has((n) => n.block === e.to)) add('warn', sc.id, id, `На сценарии «${b.title}» вызывает «${title(e.to)}», но в блок-схеме нет шага с этим вызовом (block: ${e.to})`);
      }
    }
  }
  return { issues, errors: issues.filter((i) => i.sev === 'err').length, warnings: issues.filter((i) => i.sev === 'warn').length };
}
