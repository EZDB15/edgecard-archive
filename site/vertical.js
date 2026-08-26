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
  var host = document.querySelector("[data-vertical]");
  var src = document.getElementById("ec-vertical");
  if (!host || !src) return;

  var D;
  try { D = JSON.parse(src.textContent || "null"); } catch (e) { return; }
  if (!D || !D.races || !D.races.length || !D.pools || !D.pools.length) return;

  var STEPS = [2,4,6,10,16,24,36,50,80,120,200];
  var MAX_BOX = 10;
  // One exponent per finishing position: [second, third, fourth]. Position one
  // is never corrected -- that is the market's own win probability. Absent, the
  // page falls back to plain Harville rather than to a guess.
  var LAMS = D.lambdas || [1, 1, 1];
  function lamFor(pos) {            // pos is 1-indexed
    if (pos <= 1) return 1.0;
    return LAMS[Math.min(pos - 2, LAMS.length - 1)];
  }

  // One exact finishing order.
  //
  // Position one is the market's own win probability, untouched. Every position
  // after it draws from whoever is LEFT IN THE FIELD -- not from whoever is on
  // the ticket -- with the remaining probabilities raised to LAM and
  // renormalised. Getting that denominator wrong turned a 46.3% exacta box into
  // 73.8% in the Python reference and looked entirely reasonable.
  //
  // An exponent below 1 flattens the field for the places behind the winner,
  // which is what 114,939 real finishes say it should do -- and it asks for far
  // more of it further back: 0.87 at second, 0.66 at third, 0.53 at fourth.
  // Once three horses are gone, the order of the rest has little to do with
  // their chance of WINNING, and Harville keeps assuming it is proportional to
  // exactly that.
  function orderProb(order, ps) {
    var used = {}, prod = 0, i, j, den, lm;
    for (i = 0; i < order.length; i++) {
      if (i === 0) {
        prod = ps[order[0]];
      } else {
        lm = lamFor(i + 1);
        den = 0;
        for (j = 0; j < ps.length; j++) {
          if (!used[j]) { den += Math.pow(ps[j], lm); }
        }
        if (den <= 1e-12) return 0;
        prod *= Math.pow(ps[order[i]], lm) / den;
      }
      used[order[i]] = true;
    }
    return prod;
  }

  // Every ordered arrangement of `k` drawn from `pool`, optionally with a fixed
  // horse in front. `pool` holds indices into ps.
  function arrangements(pool, k, fixed) {
    var out = [];
    var start = fixed == null ? [] : [fixed];
    (function walk(prefix, left) {
      if (prefix.length === k) { out.push(prefix.slice()); return; }
      for (var i = 0; i < left.length; i++) {
        var rest = left.slice(0, i).concat(left.slice(i + 1));
        prefix.push(left[i]);
        walk(prefix, rest);
        prefix.pop();
      }
    })(start, pool.filter(function (x) { return x !== fixed; }));
    return out;
  }

  function score(ps, pool, k, fixed) {
    var arr = arrangements(pool, k, fixed);
    var hit = 0;
    for (var i = 0; i < arr.length; i++) { hit += orderProb(arr[i], ps); }
    return { combos: arr.length, hit: hit };
  }

  function money(v) { return "$" + v.toFixed(2); }

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) { e.className = cls; }
    if (text != null) { e.textContent = text; }
    return e;
  }

  function field(labelText, control) {
    var w = el("label", "vb-field");
    w.appendChild(el("span", "vb-lab", labelText));
    w.appendChild(control);
    return w;
  }

  // ---- controls ----------------------------------------------------------
  var bar = el("div", "vb-bar");

  var raceSel = el("select", "vb-sel");
  D.races.forEach(function (r, i) {
    var o = document.createElement("option");
    o.value = String(i); o.textContent = "Race " + r.race;
    raceSel.appendChild(o);
  });
  bar.appendChild(field("Race", raceSel));

  var poolSel = el("select", "vb-sel");
  D.pools.forEach(function (p, i) {
    var o = document.createElement("option");
    o.value = String(i); o.textContent = p.name;
    poolSel.appendChild(o);
  });
  bar.appendChild(field("Bet", poolSel));

  var shapeSel = el("select", "vb-sel");
  [["box", "Box"], ["key", "Key one horse on top"]].forEach(function (pair) {
    var o = document.createElement("option");
    o.value = pair[0]; o.textContent = pair[1];
    shapeSel.appendChild(o);
  });
  bar.appendChild(field("Shape", shapeSel));

  var keySel = el("select", "vb-sel");
  var keyWrap = field("Key horse", keySel);
  keyWrap.hidden = true;
  bar.appendChild(keyWrap);

  var slider = document.createElement("input");
  slider.type = "range"; slider.className = "vb-range";
  slider.min = "0"; slider.max = String(STEPS.length - 1);
  slider.step = "1"; slider.value = "3";
  var budWrap = field("Budget", slider);
  var budVal = el("output", "vb-out", "$" + STEPS[3]);
  budWrap.appendChild(budVal);
  bar.appendChild(budWrap);

  host.appendChild(bar);
  var body = el("div", "vb-body");
  body.setAttribute("aria-live", "polite");
  host.appendChild(body);

  function fillKeys() {
    var race = D.races[parseInt(raceSel.value, 10) || 0];
    var prev = keySel.value;
    keySel.textContent = "";
    race.runners.forEach(function (r, i) {
      var o = document.createElement("option");
      o.value = String(i); o.textContent = r.program + " " + r.name;
      keySel.appendChild(o);
    });
    if (prev && prev < race.runners.length) { keySel.value = prev; }
  }

  function render() {
    var race = D.races[parseInt(raceSel.value, 10) || 0];
    var pool = D.pools[parseInt(poolSel.value, 10) || 0];
    var budget = STEPS[parseInt(slider.value, 10) || 0];
    var shape = shapeSel.value;
    var keyIdx = parseInt(keySel.value, 10) || 0;
    budVal.textContent = "$" + budget;
    keyWrap.hidden = shape !== "key";
    body.textContent = "";

    var ps = race.runners.map(function (r) { return r.p; });
    var k = pool.legs;

    // Widen while it still fits. Hit probability rises with every horse added
    // and so does cost, so the largest affordable set is the best one -- there
    // is no allocation choice here the way there is across the legs of a
    // sequence.
    var best = null;
    for (var n = k; n <= Math.min(MAX_BOX, race.runners.length); n++) {
      var pool_ids = [];
      for (var i = 0; i < n; i++) { pool_ids.push(i); }
      if (shape === "key" && pool_ids.indexOf(keyIdx) === -1) { pool_ids.push(keyIdx); }
      var got = score(ps, pool_ids, k, shape === "key" ? keyIdx : null);
      var cost = got.combos * pool.base;
      if (cost > budget + 1e-9) { break; }
      best = { n: n, ids: pool_ids, combos: got.combos, hit: got.hit, cost: cost };
    }

    if (!best) {
      body.appendChild(el("p", "vb-none",
        "The smallest " + pool.name.toLowerCase() + " in this race costs more " +
        "than $" + budget + " at this track's " + money(pool.base) + " minimum."));
      return;
    }

    var list = el("div", "vb-horses");
    best.ids.forEach(function (i) {
      var r = race.runners[i];
      var mine = shape === "key" && i === keyIdx;
      var chip = el("span", "vb-c" + (mine ? " vb-key" : ""));
      chip.appendChild(pgmBits(race.race, r.program));
      chip.appendChild(document.createTextNode(" " + r.name));
      if (mine) { chip.title = "on top of every combination"; }
      list.appendChild(chip);
    });
    body.appendChild(list);

    var fair = best.hit > 0 ? best.cost / best.hit : 0;
    var sum = el("p", "vb-sum");
    sum.appendChild(el("b", null, best.combos + " combination" +
      (best.combos === 1 ? "" : "s")));
    sum.appendChild(document.createTextNode(
      " \u00b7 " + money(best.cost) + " at " + money(pool.base) +
      " a combination \u00b7 hits "));
    sum.appendChild(el("b", null, (best.hit * 100).toFixed(1) + "%"));
    sum.appendChild(document.createTextNode(" of the time"));
    body.appendChild(sum);

    var brk = el("p", "vb-brk");
    brk.appendChild(document.createTextNode("Breaks even at "));
    brk.appendChild(el("b", null, money(fair)));
    brk.appendChild(document.createTextNode(
      ". This pool takes " + Math.round(pool.takeout * 100) + "%, so the " +
      "winning combination has to be worth " +
      money(fair / (1 - pool.takeout)) + " before takeout for the bet to be even."));
    body.appendChild(brk);

    var note = el("p", "vb-note");
    note.textContent =
      "The usual way to price these treats each place behind the winner as a " +
      "fresh race among the losers. Over 114,939 finishes that overstates a " +
      "favourite's chance of running second by about a third, and it gets " +
      "worse further back. These prices are corrected for it. The correction " +
      "removes roughly 40% of the error at second and is not complete: a heavy " +
      "favourite is still a little overstated, so a price keyed on one still " +
      "leans optimistic.";
    body.appendChild(note);
  }

  raceSel.addEventListener("change", function () { fillKeys(); render(); });
  poolSel.addEventListener("change", render);
  shapeSel.addEventListener("change", render);
  keySel.addEventListener("change", render);
  slider.addEventListener("input", render);

  fillKeys();
  render();
  host.removeAttribute("hidden");
})();
