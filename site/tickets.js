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
    badge.className = "pgm" + (n ? " p" + n[0] : "");
    badge.textContent = String(program == null ? "" : program);
    frag.appendChild(badge);
    return frag;
  }
  var host = document.querySelector("[data-ticket-builder]");
  var src = document.getElementById("ec-sequences");
  if (!host || !src) return;

  var seqs;
  try { seqs = JSON.parse(src.textContent || "[]"); } catch (e) { return; }
  if (!seqs.length) return;

  var STEPS = [2,4,6,10,16,24,36,50,80,120,200,320];
  var MAX_W = 8;

  // ---- optional: cover legs with the horses that fit a reader's style ------
  // The style tool publishes its weights on a custom event and its factor map
  // in its own data island. Both are optional: with the style tool absent, or
  // with every weight at zero, this whole section stays switched off and the
  // builder behaves exactly as it did before.
  // Read straight from storage rather than waiting to be told. Both scripts
  // are deferred and execute in document order, so the event would arrive in
  // the right sequence today -- but that is an accident of the order two
  // hrefs happen to sit in a list, and a reader whose ticket builder silently
  // lost its style checkbox would have no way to know why.
  var styleWeights = null;
  try {
    styleWeights = JSON.parse(localStorage.getItem("ec_style_v1") || "null");
  } catch (e) {}

  var factorsByKey = {};
  (function () {
    var ssrc = document.getElementById("ec-style");
    if (!ssrc) return;
    try {
      var S = JSON.parse(ssrc.textContent || "null");
      (S.runners || []).forEach(function (r) {
        factorsByKey[r.race + "/" + r.program] = r.factors || [];
      });
    } catch (e) {}
  })();

  function styleIsOn() {
    if (!styleWeights) return false;
    for (var k in styleWeights) {
      if (styleWeights[k]) return true;
    }
    return false;
  }

  function fitOf(race, program) {
    var f = factorsByKey[race + "/" + program];
    if (!f || !styleWeights) return 0;
    var s = 0;
    f.forEach(function (x) { if (styleWeights[x]) s += styleWeights[x]; });
    return s;
  }

  // Style decides WHICH horses, never the arithmetic. The chance of getting
  // through a leg is still the summed win probability of whoever is covered,
  // because fit is not a probability and pretending otherwise would put a
  // number on the page that means nothing.
  //
  // Style-first, never style-only: once the horses with positive fit run out,
  // the leg fills by probability. A ticket that refused to widen would just
  // vanish at most budgets, which is not a more honest answer, only a less
  // useful one.
  function order(leg, useStyle) {
    var rs = leg.runners.slice();
    if (!useStyle) return rs;
    return rs.sort(function (a, b) {
      var fa = fitOf(leg.race, a.program), fb = fitOf(leg.race, b.program);
      if (fa > 0 || fb > 0) { if (fb !== fa) return fb - fa; }
      return b.p - a.p;
    });
  }

  // Cumulative win probability of the n most likely horses in a leg.
  function masses(runners) {
    var out = [], t = 0, i;
    for (i = 0; i < runners.length && i < MAX_W; i++) {
      t += Math.max(0, runners[i].p);
      out.push(Math.min(t, 1));
    }
    return out;
  }

  // Exhaustive over leg widths, pruned by budget. Cost and hit are both
  // products over the legs, and a leg's mass is concave in its width while its
  // cost is linear, so a greedy walk can strand budget it cannot spend. The
  // search is small enough that it does not have to.
  function optimise(seq, budget, useStyle) {
    var legs = seq.legs.map(function (l) { return masses(order(l, useStyle)); });
    var best = null;
    (function walk(i, widths, cost, hit) {
      if (cost > budget + 1e-9) return;
      if (i === legs.length) {
        if (!best || hit > best.hit) {
          best = { hit: hit, cost: cost, widths: widths.slice() };
        }
        return;
      }
      for (var n = Math.min(MAX_W, legs[i].length); n >= 1; n--) {
        var step = cost ? cost * n : seq.base * n;
        if (step > budget + 1e-9) continue;
        widths.push(n);
        walk(i + 1, widths, step, hit * legs[i][n - 1]);
        widths.pop();
      }
    })(0, [], 0, 1);
    return best;
  }

  function money(v) { return "$" + v.toFixed(2); }

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) { e.className = cls; }
    if (text != null) { e.textContent = text; }
    return e;
  }

  // ---- controls ----------------------------------------------------------
  var bar = el("div", "tb-bar");

  var pickWrap = el("label", "tb-field");
  pickWrap.appendChild(el("span", "tb-lab", "Sequence"));
  var pick = el("select", "tb-sel");
  pick.id = "tb-seq";
  seqs.forEach(function (s, i) {
    var o = document.createElement("option");
    o.value = String(i);
    o.textContent = s.name;
    pick.appendChild(o);
  });
  pickWrap.appendChild(pick);

  var styleWrap = el("label", "tb-field tb-style");
  styleWrap.hidden = true;
  var styleBox = document.createElement("input");
  styleBox.type = "checkbox";
  styleBox.className = "tb-check";
  styleBox.id = "tb-usestyle";
  var styleTxt = el("span", "tb-checklab", "Cover with the horses that fit my style");
  styleWrap.appendChild(styleBox);
  styleWrap.appendChild(styleTxt);
  styleBox.addEventListener("change", render);

  document.addEventListener("ec:style", function (ev) {
    styleWeights = (ev.detail || {}).weights || null;
    styleWrap.hidden = !styleIsOn();
    if (styleWrap.hidden) { styleBox.checked = false; }
    render();
  });

  var budWrap = el("label", "tb-field");
  budWrap.appendChild(el("span", "tb-lab", "Budget"));
  var slider = document.createElement("input");
  slider.type = "range";
  slider.className = "tb-range";
  slider.min = "0";
  slider.max = String(STEPS.length - 1);
  slider.step = "1";
  slider.value = "4";
  slider.id = "tb-budget";
  budWrap.appendChild(slider);
  var budVal = el("output", "tb-out", "$" + STEPS[4]);
  budVal.setAttribute("for", "tb-budget");
  budWrap.appendChild(budVal);

  bar.appendChild(pickWrap);
  bar.appendChild(budWrap);
  host.appendChild(bar);
  host.appendChild(styleWrap);

  var body = el("div", "tb-body");
  body.setAttribute("aria-live", "polite");
  host.appendChild(body);

  // ---- render ------------------------------------------------------------
  function render() {
    var seq = seqs[parseInt(pick.value, 10) || 0];
    var budget = STEPS[parseInt(slider.value, 10) || 0];
    budVal.textContent = "$" + budget;
    body.textContent = "";

    var useStyle = styleBox.checked && styleIsOn();
    var best = optimise(seq, budget, useStyle);
    if (!best) {
      body.appendChild(el("p", "tb-none",
        "One horse in every leg already costs more than $" + budget +
        " in this pool."));
      return;
    }

    var tbl = el("table", "tb-tbl");
    var tb = document.createElement("tbody");
    seq.legs.forEach(function (leg, i) {
      var n = best.widths[i];
      var ranked = order(leg, useStyle);
      var tr = document.createElement("tr");
      tr.appendChild(el("th", "tb-r", "R" + leg.race));
      var td = el("td", "tb-h");
      var m = 0;
      ranked.slice(0, n).forEach(function (r) {
        m += r.p;
        var mine = r.program === leg.play;
        var chip = el("span", "tb-c" + (mine ? " tb-play" : ""));
        chip.appendChild(pgmBits(leg.race, r.program));
        chip.appendChild(document.createTextNode(" " + r.name));
        if (mine) { chip.title = "the horse we are betting to win in this race"; }
        td.appendChild(chip);
      });
      tr.appendChild(td);
      tr.appendChild(el("td", "tb-m", Math.round(Math.min(m, 1) * 100) + "%"));
      tb.appendChild(tr);
    });
    tbl.appendChild(tb);
    body.appendChild(tbl);

    var combos = Math.round(best.cost / seq.base);
    var fair = best.hit > 0 ? best.cost / best.hit : 0;

    var sum = el("p", "tb-sum");
    sum.appendChild(el("b", null, combos + " combination" + (combos === 1 ? "" : "s")));
    sum.appendChild(document.createTextNode(
      " \u00b7 " + money(best.cost) + " at " + money(seq.base) +
      " a line \u00b7 gets through "));
    sum.appendChild(el("b", null, (best.hit * 100).toFixed(2) + "%"));
    sum.appendChild(document.createTextNode(" of the time"));
    body.appendChild(sum);

    var brk = el("p", "tb-brk");
    brk.appendChild(document.createTextNode("Breaks even at a "));
    brk.appendChild(el("b", null, money(fair)));
    brk.appendChild(document.createTextNode(
      " payoff. This pool takes " + Math.round(seq.takeout * 100) +
      "%, so the winning combination has to be worth " +
      money(fair / (1 - seq.takeout)) + " before takeout for the bet to be even."));
    body.appendChild(brk);

    // What the style cost, stated. A fit-covered ticket gets through less often
    // than a probability-covered one at the same money, by construction, and a
    // reader is owed that number rather than left to assume they lost nothing.
    if (useStyle) {
      var plain = optimise(seq, budget, false);
      var cost = el("p", "tb-cost");
      if (plain && plain.hit > best.hit) {
        cost.appendChild(document.createTextNode("Covering by probability instead "));
        cost.appendChild(el("b", null, "would get through " +
          (plain.hit * 100).toFixed(2) + "%"));
        cost.appendChild(document.createTextNode(
          " for the same money. The gap is what playing your own style costs " +
          "on this ticket."));
      } else if (plain) {
        cost.textContent = "Your style covers the same horses probability " +
          "would have here, so it costs nothing on this ticket.";
      }
      body.appendChild(cost);
    }
  }

  pick.addEventListener("change", render);
  slider.addEventListener("input", render);
  styleWrap.hidden = !styleIsOn();
  render();
  host.removeAttribute("hidden");
})();
