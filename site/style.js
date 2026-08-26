
(function () {

  "use strict";

  // The saddle-cloth colour and the silk, from the island silks.js publishes.
  // Absent island, absent colours, and the number reads exactly as it did.
  // The markup is server-generated and comes from our own island; it is never
  // user input, and the alternative is a second silk renderer in JavaScript.
  function pgmBits(race, program) {
    var frag = document.createDocumentFragment();
    var row = window.ecRunner ? window.ecRunner(race, program) : null;
    if (row && row.s) {
      var slot = document.createElement("span");
      slot.className = "silk-slot";
      slot.innerHTML = row.s;
      frag.appendChild(slot);
    }
    var n = String(program == null ? "" : program).match(/^\d+/);
    var badge = document.createElement("span");
    badge.className = "pgm st-pg" + (n ? " p" + n[0] : "");
    badge.textContent = String(program == null ? "" : program);
    frag.appendChild(badge);
    return frag;
  }

  var host = document.querySelector("[data-style-tool]");

  var src = document.getElementById("ec-style");

  if (!host || !src) return;



  var D;

  try { D = JSON.parse(src.textContent || "null"); } catch (e) { return; }

  if (!D || !D.runners || !D.runners.length) return;



  var KEY = "ec_style_v1";

  var MODE_KEY = KEY + "_mode";

  var weights = {};



  // Three views of the same weights, not three tools. The card already carries

  // more sections than a reader wants to scroll, and the honest difference

  // between these is what QUESTION is being asked, not what data is behind it.

  //

  //   rank     which horses fit what I said I care about

  //   compare  where two styles disagree, which is the point: style is a

  //            choice, and two people looking at the same race honestly reach

  //            different horses

  //   filter   show me the field and let me decide -- ranks nothing, claims

  //            nothing, and is the only mode that makes no assertion at all

  var MODES = [

    ["rank", "Rank", "by how well each horse fits you"],

    ["compare", "Compare", "two styles on the same race"],

    ["filter", "Filter", "the field, ranked by nothing"]

  ];

  var mode = "rank";

  try { mode = localStorage.getItem(MODE_KEY) || "rank"; } catch (e) {}

  if (!MODES.some(function (m) { return m[0] === mode; })) { mode = "rank"; }



  // Which two styles the compare view holds, as indices into `comparable()`.

  // Index 0 is always the reader's own weights: comparing what THEY built

  // against a named style is the more interesting question, and it was the

  // one this view could not ask when it only knew about presets.

  var cmpA = 0, cmpB = 1;



  //: The reader's own weights, plus every preset. `weights` is passed by

  //: reference so "My style" always reflects whatever the sliders say right

  //: now, including edits made in another mode.

  function comparable() {

    return [{ key: "__mine", name: "My style", weights: weights }]

      .concat(D.personas);

  }



  function hasAnyWeight(w) {

    for (var k in w) { if (w[k]) return true; }

    return false;

  }



  function allFactors() {

    var out = [];

    D.families.forEach(function (f) {

      f.factors.forEach(function (pair) { out.push(pair[0]); });

    });

    return out;

  }



  function load() {

    var saved = null;

    try { saved = JSON.parse(localStorage.getItem(KEY) || "null"); } catch (e) {}

    allFactors().forEach(function (f) { weights[f] = 0; });

    if (saved && typeof saved === "object") {

      allFactors().forEach(function (f) {

        var v = Number(saved[f]);

        if (isFinite(v)) weights[f] = Math.max(-100, Math.min(100, v));

      });

    } else if (D.personas && D.personas.length) {

      applyPersona(D.personas[0], true);

    }

  }



  function save() {

    try { localStorage.setItem(KEY, JSON.stringify(weights)); } catch (e) {}

    announce();

  }



  // The ticket builder listens for this so a reader can cover legs with the

  // horses that fit their style. A custom event rather than a shared global:

  // the two scripts are separate files with no bundler between them, and an

  // event keeps the dependency one-way -- the ticket builder needs the style

  // tool, the style tool does not need to know the ticket builder exists.

  function announce() {

    try {

      document.dispatchEvent(new CustomEvent("ec:style", {

        detail: { weights: weights }

      }));

    } catch (e) {}

  }



  // Per FACTOR, not per family: a style has a direction on each thing it looks

  // at. Anything the persona does not name is cleared to zero, so applying one

  // replaces a previous style rather than layering on top of it.

  function applyPersona(p, quiet) {

    allFactors().forEach(function (f) {

      var w = p.weights[f];

      weights[f] = (w === undefined) ? 0 : w;

    });

    if (!quiet) { save(); draw(); }

  }



  // ---- scoring -----------------------------------------------------------

  // Fit, not probability. The sum of the weights a horse's own factors carry,

  // shown against the widest sum any horse on the card reached, so the scale is

  // the card's own rather than an absolute nobody can interpret.

  function fit(r) {

    var s = 0;

    r.factors.forEach(function (f) { if (weights[f]) s += weights[f]; });

    return s;

  }



  // What a reader's current mix has actually done against the closing line.

  // Weighted by SAMPLE SIZE, not by the slider: a factor they care about which

  // has fired forty times should not outvote one that has fired twelve hundred.

  function mixRecord() {

    var num = 0, den = 0, n = 0, missing = 0;

    allFactors().forEach(function (f) {

      var w = weights[f];

      if (w <= 0) return;                 // "avoid" says nothing about a record

      var rec = D.records[f];

      if (!rec) { missing++; return; }

      num += w * rec.starts * rec.ratio;

      den += w * rec.starts;

      n += rec.starts;

    });

    if (!den) return null;

    return { ratio: num / den, starts: n, missing: missing };

  }



  // ---- motion -------------------------------------------------------------

  // FLIP, and only for the reorder. When a style re-ranks a race the reader is

  // looking for WHICH horse moved, and a snap-redraw destroys exactly that: the

  // list is just different afterwards. So each row is measured before the

  // redraw, put back where it was, and released.

  //

  // It degrades to nothing. With reduced motion requested, or if a row is new

  // or has gone, no transform is applied and the redraw is what it always was.

  function stillness() {

    try {

      return window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    } catch (e) { return false; }

  }



  function positions() {

    var out = {};

    if (stillness()) return out;

    var rows = right.querySelectorAll("tr[data-key]");

    for (var i = 0; i < rows.length; i++) {

      out[rows[i].getAttribute("data-key")] = rows[i].getBoundingClientRect().top;

    }

    return out;

  }



  function replay(before) {

    if (stillness()) return;

    var rows = right.querySelectorAll("tr[data-key]");

    for (var i = 0; i < rows.length; i++) {

      var row = rows[i];

      var was = before[row.getAttribute("data-key")];

      if (was === undefined) continue;                 // new to the list

      var delta = was - row.getBoundingClientRect().top;

      if (!delta) continue;

      row.style.transition = "none";

      row.style.transform = "translateY(" + delta + "px)";

    }

    function release() {

      var again = right.querySelectorAll("tr[data-key]");

      for (var j = 0; j < again.length; j++) {

        again[j].style.transition = "";

        again[j].style.transform = "";

      }

    }



    // Two frames: one to let the browser take the inverted position as the

    // start, one to release it. Doing both in the same frame paints only the

    // end state and nothing appears to move.

    requestAnimationFrame(function () { requestAnimationFrame(release); });



    // And a timer as a safety net, because requestAnimationFrame DOES NOT FIRE

    // in a backgrounded tab. Without this, a reader who switches tabs while the

    // list is mid-flight comes back to rows frozen at their inverted offsets --

    // a permanently scrambled list, from an animation that never finished.

    // Releasing twice is harmless; releasing never is not.

    setTimeout(release, 500);

  }



  // Last-seen values live HERE, not on the node. The element is rebuilt on

  // every redraw, so anything stashed on it is gone by the time we would

  // compare against it -- the first version of this stored state on the node

  // and therefore never fired once.

  var lastSeen = {};



  function markChanged(node, key, value) {

    var had = Object.prototype.hasOwnProperty.call(lastSeen, key);

    var changed = had && lastSeen[key] !== value;

    lastSeen[key] = value;

    if (!changed || stillness()) return;

    node.classList.add("ec-changed");

  }



  function el(tag, cls, text) {

    var e = document.createElement(tag);

    if (cls) { e.className = cls; }

    if (text != null) { e.textContent = text; }

    return e;

  }



  // ---- chrome ------------------------------------------------------------

  var modeBar = el("div", "st-modes");

  modeBar.setAttribute("role", "tablist");

  modeBar.setAttribute("aria-label", "How to read the card");

  var modeButtons = {};

  MODES.forEach(function (m) {

    var b = el("button", "st-mode");

    b.type = "button";

    b.setAttribute("role", "tab");

    b.appendChild(el("b", null, m[1]));

    b.appendChild(el("span", "st-modeb", m[2]));

    b.addEventListener("click", function () {

      mode = m[0];

      try { localStorage.setItem(MODE_KEY, mode); } catch (e) {}

      syncModes();

      draw();

    });

    modeButtons[m[0]] = b;

    modeBar.appendChild(b);

  });

  host.appendChild(modeBar);



  function syncModes() {

    MODES.forEach(function (m) {

      var on = m[0] === mode;

      modeButtons[m[0]].classList.toggle("st-mode-on", on);

      modeButtons[m[0]].setAttribute("aria-selected", on ? "true" : "false");

    });

  }



  var bar = el("div", "st-personas");

  bar.setAttribute("role", "group");

  bar.setAttribute("aria-label", "Handicapping styles");

  D.personas.forEach(function (p) {

    var b = el("button", "st-p");

    b.type = "button";

    b.appendChild(el("b", null, p.name));

    b.appendChild(el("span", "st-pb", p.blurb));

    b.addEventListener("click", function () { applyPersona(p); });

    bar.appendChild(b);

  });

  host.appendChild(bar);



  var cols = el("div", "st-cols");

  var left = el("div", "st-controls");

  var right = el("div", "st-results");

  right.setAttribute("aria-live", "polite");

  cols.appendChild(left);

  cols.appendChild(right);

  host.appendChild(cols);



  function recordLine(f) {

    var rec = D.records[f];

    var s = el("span", "st-rec");

    if (!rec) {

      s.className += " st-rec-none";

      s.textContent = "not measured yet";

      return s;

    }

    s.appendChild(el("b", null, rec.ratio.toFixed(2) + "\u00d7"));

    s.appendChild(document.createTextNode(

      " the closing line over " + rec.starts.toLocaleString() + " runners"));

    if (!rec.beats) { s.title = "no edge over the market has been shown"; }



    // The meet's own figure, on request only. Printed inline it would stage a

    // contrast between two numbers that are not distinguishable from one

    // another -- Saratoga and Del Mar put a bullet work at 1.01 with an

    // interval of [0.91, 1.12], which swallows the 1.06 measured across 67

    // tracks. Opened deliberately, with its interval attached, it shows a

    // reader exactly that it settles nothing.

    if (rec.meet && rec.meet.starts) {

      var det = document.createElement("details");

      det.className = "st-meet";

      var sm = document.createElement("summary");

      sm.textContent = "at this meet";

      det.appendChild(sm);

      var m = rec.meet;

      var swallows = m.lo != null && m.hi != null &&

                     m.lo <= rec.ratio && rec.ratio <= m.hi;

      det.appendChild(el("span", null,

        m.ratio.toFixed(2) + "\u00d7 over " + m.starts.toLocaleString() +

        " runners here" +

        (m.lo != null

          ? ", 95% " + m.lo.toFixed(2) + " to " + m.hi.toFixed(2) : "") +

        (swallows

          ? " \u2013 too few to tell it apart from the figure above." : ".")));

      s.appendChild(det);

    }

    return s;

  }



  function buildControls() {

    left.textContent = "";

    D.families.forEach(function (fam) {

      var box = el("section", "st-fam");

      var h = el("div", "st-fam-h");

      h.appendChild(el("span", "st-fam-n", fam.name));

      var setAll = el("button", "st-all", "set all");

      setAll.type = "button";

      setAll.addEventListener("click", function () {

        var first = weights[fam.factors[0][0]] || 0;

        fam.factors.forEach(function (p) { weights[p[0]] = first; });

        save(); draw();

      });

      h.appendChild(setAll);

      box.appendChild(h);



      fam.factors.forEach(function (pair) {

        var f = pair[0], label = pair[1];

        var row = el("div", "st-row");

        var lab = el("label", "st-lab");

        lab.setAttribute("for", "w-" + f);

        lab.appendChild(el("span", "st-name", label));

        lab.appendChild(recordLine(f));

        row.appendChild(lab);



        var sl = document.createElement("input");

        sl.type = "range";

        sl.className = "st-range";

        sl.id = "w-" + f;

        sl.min = "-100"; sl.max = "100"; sl.step = "10";

        sl.value = String(weights[f] || 0);

        sl.addEventListener("input", function () {

          weights[f] = Number(sl.value);

          save();

          draw(true);

        });

        row.appendChild(sl);

        box.appendChild(row);

      });

      left.appendChild(box);

    });

  }



  // Strongest single match: the one thing a reader cares most about that this

  // horse actually has. Shown alongside the sum, because a horse can lead on

  // accumulation -- three things you mildly want -- while missing the one thing

  // you actually came for, and the sum alone hides that completely.

  function strongest(r) {

    var best = null, bestW = 0;

    r.factors.forEach(function (f) {

      var w = weights[f] || 0;

      if (w > bestW) { bestW = w; best = f; }

    });

    return best;

  }



  function labelOf(f) {

    var name = null;

    D.families.forEach(function (fam) {

      fam.factors.forEach(function (p) { if (p[0] === f) name = p[1]; });

    });

    return name;

  }



  function racesInOrder() {

    var by = {}, order = [];

    D.runners.forEach(function (r) {

      if (!by[r.race]) { by[r.race] = []; order.push(r.race); }

      by[r.race].push(r);

    });

    order.sort(function (a, b) { return a - b; });

    return order.map(function (n) { return { race: n, runners: by[n] }; });

  }



  function horseRow(r, top, marked) {

    var tr = document.createElement("tr");

    tr.setAttribute("data-key", r.race + "/" + r.program);

    var td = el("td", "st-h");

    td.appendChild(pgmBits(r.race, r.program));

    td.appendChild(document.createTextNode(" " + r.name));

    var why = el("div", "st-why");

    r.factors.forEach(function (f) {

      if (!weights[f]) return;

      var name = labelOf(f);

      if (!name) return;

      var cls = "st-chip" + (weights[f] < 0 ? " st-neg" : "") +

                (f === marked ? " st-top" : "");

      var chip = el("span", cls, name);

      if (f === marked) { chip.title = "the thing you care most about that this horse has"; }

      why.appendChild(chip);

    });

    if (why.childNodes.length) { td.appendChild(why); }

    tr.appendChild(td);



    var bar = el("td", "st-bar");

    if (top > 0) {

      var fill = el("span", "st-fill");

      fill.style.width = Math.round((fit(r) / top) * 100) + "%";

      bar.appendChild(fill);

    }

    tr.appendChild(bar);

    tr.appendChild(el("td", "st-prob",

      r.p != null ? Math.round(r.p * 100) + "%" : "\u2013"));

    return tr;

  }



  // ---- compare: two styles, same race ------------------------------------

  function fitWith(r, w) {

    var s = 0;

    r.factors.forEach(function (f) { if (w[f]) s += w[f]; });

    return s;

  }



  function topFor(runners, w, n) {

    return runners

      .map(function (r) { return { r: r, s: fitWith(r, w) }; })

      .filter(function (x) { return x.s > 0; })

      .sort(function (a, b) {

        return b.s - a.s || ((b.r.p || 0) - (a.r.p || 0)) ||

               (Number(a.r.program) - Number(b.r.program));

      })

      .slice(0, n);

  }



  function drawCompare() {

    var opts = comparable();

    if (cmpA >= opts.length) { cmpA = 0; }

    if (cmpB >= opts.length) { cmpB = 1; }

    var A = opts[cmpA], B = opts[cmpB];



    var pick = el("div", "st-cmp-pick");

    [[cmpA, "A"], [cmpB, "B"]].forEach(function (pair, idx) {

      var sel = el("select", "st-sel");

      opts.forEach(function (p, i) {

        var o = document.createElement("option");

        o.value = String(i); o.textContent = p.name;

        if (i === pair[0]) { o.selected = true; }

        sel.appendChild(o);

      });

      sel.addEventListener("change", function () {

        if (idx === 0) { cmpA = Number(sel.value); } else { cmpB = Number(sel.value); }

        draw();

      });

      var w = el("label", "st-cmp-side");

      w.appendChild(el("span", "st-lab", idx === 0 ? "Style A" : "Style B"));

      w.appendChild(sel);

      pick.appendChild(w);

    });

    right.appendChild(pick);



    // "My style" with nothing weighted is an empty column, which reads as a

    // broken view rather than as an empty answer. Say which one it is.

    var blank = [A, B].filter(function (x) {

      return x.key === "__mine" && !hasAnyWeight(x.weights);

    });

    if (blank.length) {

      var warn = el("p", "st-cmp-blank",

        "You have not weighted anything yet, so My style has no opinion "

        + "to compare. Set some sliders in Rank, or start from a preset.");

      right.appendChild(warn);

    }



    var agree = 0, total = 0;

    racesInOrder().forEach(function (blk) {

      var ta = topFor(blk.runners, A.weights, 3);

      var tb = topFor(blk.runners, B.weights, 3);

      if (!ta.length && !tb.length) { return; }

      total++;

      var sameTop = ta.length && tb.length &&

                    ta[0].r.program === tb[0].r.program;

      if (sameTop) { agree++; }



      var sec = el("section", "st-race");

      var h = el("div", "st-race-h");

      h.appendChild(el("span", "st-race-n", "R" + blk.race));

      if (sameTop) {

        h.appendChild(el("span", "st-agree", "both land on the same horse"));

      }

      sec.appendChild(h);



      var grid = el("div", "st-cmp");

      [ta, tb].forEach(function (side, i) {

        var col = el("div", "st-cmp-col");

        col.appendChild(el("div", "st-cmp-h", i === 0 ? A.name : B.name));

        if (!side.length) {

          col.appendChild(el("div", "st-cmp-none", "nothing fits"));

        }

        var otherTop = (i === 0 ? tb : ta)[0];

        side.forEach(function (x, rank) {

          var shared = otherTop && otherTop.r.program === x.r.program;

          var row = el("div", "st-cmp-row" + (shared ? " st-shared" : ""));

          row.appendChild(pgmBits(x.r.race, x.r.program));

          row.appendChild(document.createTextNode(" " + x.r.name));

          if (rank === 0) { row.className += " st-cmp-first"; }

          col.appendChild(row);

        });

        grid.appendChild(col);

      });

      sec.appendChild(grid);

      right.appendChild(sec);

    });



    var note = el("p", "st-foot");

    note.textContent = total

      ? A.name + " and " + B.name + " pick the same horse in " + agree +

        " of " + total + " races. Where they disagree, neither is wrong: " +

        "they are answering different questions, and nothing we have measured " +

        "says either question finds more winners."

      : "Neither style finds anything on this card.";

    right.appendChild(note);

  }



  // ---- filter: the field, ranked by nothing -------------------------------

  function drawFilter() {

    var chosen = allFactors().filter(function (f) { return weights[f] > 0; });

    var head = el("div", "st-mix");

    head.textContent = chosen.length

      ? "Every horse carrying anything you weighted, in race order. Nothing " +

        "here is ranked and nothing is recommended."

      : "Weight a factor, or pick a style, and every horse carrying it appears " +

        "here in race order.";

    right.appendChild(head);

    if (!chosen.length) { return; }



    var shown = 0;

    racesInOrder().forEach(function (blk) {

      var hits = blk.runners.filter(function (r) {

        return r.factors.some(function (f) { return chosen.indexOf(f) !== -1; });

      }).sort(function (a, b) {

        return Number(a.program) - Number(b.program);   // program order, not merit

      });

      if (!hits.length) { return; }

      shown += hits.length;

      var sec = el("section", "st-race");

      var h = el("div", "st-race-h");

      h.appendChild(el("span", "st-race-n", "R" + blk.race));

      h.appendChild(el("span", "st-agree", hits.length + " of " +

        blk.runners.length));

      sec.appendChild(h);

      var tbl = el("table", "st-tbl");

      var tb = document.createElement("tbody");

      hits.forEach(function (r) { tb.appendChild(horseRow(r, 0, null)); });

      tbl.appendChild(tb);

      sec.appendChild(tbl);

      right.appendChild(sec);

    });



    var note = el("p", "st-foot");

    note.textContent = shown +

      " horses carry something you asked about, listed by program number so " +

      "the order says nothing. This is the only view that makes no claim at " +

      "all \u2013 it shows you the field and stops.";

    right.appendChild(note);

  }



  function drawResults() {

    right.textContent = "";

    if (mode === "compare") { drawCompare(); return; }

    if (mode === "filter") { drawFilter(); return; }



    var mix = mixRecord();

    var head = el("div", "st-mix");

    if (mix) {

      head.appendChild(document.createTextNode("What you are asking for has run "));

      head.appendChild(el("b", null, mix.ratio.toFixed(2) + "\u00d7"));

      head.appendChild(document.createTextNode(

        " what the closing board expected, across " +

        mix.starts.toLocaleString() + " runners at these meets. " +

        "A 1.00 means the market already priced it."));

      markChanged(head, "mix", mix.ratio.toFixed(2));

    } else {

      head.appendChild(document.createTextNode(

        "Move a slider, or pick a style, to rank each race by what you look for."));

      right.appendChild(head);

      return;

    }

    right.appendChild(head);



    // The card's own ceiling, so the bars are comparable BETWEEN races rather

    // than each race being rescaled to its own best and every race looking

    // equally strong.

    var top = 0;

    D.runners.forEach(function (r) { top = Math.max(top, fit(r)); });



    var empties = 0;

    racesInOrder().forEach(function (blk) {

      var fits = blk.runners.filter(function (r) { return fit(r) > 0; });

      fits.sort(function (a, b) {

        return fit(b) - fit(a) || ((b.p || 0) - (a.p || 0)) ||

               (Number(a.program) - Number(b.program));

      });



      var sec = el("section", "st-race");

      var h = el("div", "st-race-h");

      h.appendChild(el("span", "st-race-n", "R" + blk.race));

      sec.appendChild(h);



      var tbl = el("table", "st-tbl");

      var tb = document.createElement("tbody");



      if (fits.length) {

        fits.slice(0, 3).forEach(function (r) {

          tb.appendChild(horseRow(r, top, strongest(r)));

        });

      } else {

        empties++;

        // Saying nothing fits is the honest answer, and for some styles it is

        // the answer three races in five. Offering our own pick keeps the race

        // from being a dead end -- flagged as OURS, because the reader asked

        // for their opinion and this is not it.

        var note = el("tr", "st-empty");

        var cell = el("td", null,

          "No horse here has what you are looking for.");

        cell.colSpan = 3;

        note.appendChild(cell);

        tb.appendChild(note);

        var ours = null;

        blk.runners.forEach(function (r) {

          if (r.p != null && (!ours || r.p > ours.p)) { ours = r; }

        });

        if (ours) {

          var row = horseRow(ours, 0, null);

          row.className = "st-ours";

          row.querySelector(".st-h").insertBefore(

            el("span", "st-ourtag", "ours"),

            row.querySelector(".st-h").firstChild);

          tb.appendChild(row);

        }

      }

      tbl.appendChild(tb);

      sec.appendChild(tbl);

      right.appendChild(sec);

    });



    var note = el("p", "st-foot");

    note.appendChild(document.createTextNode(

      "Ranked inside each race by how much of what you asked for each horse " +

      "has, with the thing you care most about marked. That is not the same " +

      "question as which horse wins \u2013 the last column is our model's win " +

      "probability, and it will often disagree."));

    if (empties) {

      note.appendChild(document.createTextNode(

        " " + empties + " of " + racesInOrder().length + " races today have " +

        "nothing matching this style, which is itself worth knowing."));

    }

    right.appendChild(note);

  }



  function draw(resultsOnly) {

    var before = positions();

    if (!resultsOnly) { buildControls(); }

    // Compare drives itself from two named styles, so the persona buttons and

    // the sliders would be controls that appear to do nothing. Hiding them is

    // the honest move: a dead control is worse than an absent one.

    var editing = mode !== "compare";

    bar.hidden = !editing;

    left.hidden = !editing;

    cols.classList.toggle("st-wide", !editing);

    drawResults();

    replay(before);

  }



  load();

  syncModes();

  draw();

  announce();

  host.removeAttribute("hidden");

})();

