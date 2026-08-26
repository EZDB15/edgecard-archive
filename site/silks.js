(function () {
  "use strict";
  var island = document.getElementById("ec-runner");
  if (!island) return;

  var data;
  try { data = JSON.parse(island.textContent || "{}"); } catch (e) { return; }
  if (!data || typeof data !== "object") return;

  // Published for the builders, which render their runners from their own
  // payloads and have no silk in the DOM to copy. One lookup, one island, one
  // drawing: a second renderer in JavaScript would be a second silk that could
  // disagree with the one on the card.
  //
  // Deliberately set BEFORE the panel wiring gives up: /tools/ carries the
  // island and no silks at all, and the builders there still want the colours.
  window.ecRunner = function (race, program) {
    var n = String(program == null ? "" : program).match(/^\d+/);
    return (n && data[String(race) + "-" + n[0]]) || null;
  };

  var silks = document.querySelectorAll("svg.silk[data-r]");
  if (!silks.length) return;

  var panel = null, backdrop = null, opener = null;

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) { n.className = cls; }
    if (text != null) { n.textContent = text; }
    return n;
  }

  function close() {
    if (!panel) return;
    panel.remove(); panel = null;
    if (backdrop) { backdrop.remove(); backdrop = null; }
    if (opener) { opener.focus(); opener = null; }
  }

  function build(row, svg) {
    var box = el("div", "silkpanel");
    box.setAttribute("role", "dialog");
    box.setAttribute("aria-label", row.n || "runner");

    var head = el("div", "sp-head");
    // A copy of the silk, not the original: moving the original would leave a
    // hole in the row behind the panel.
    var copy = svg.cloneNode(true);
    copy.removeAttribute("data-r");
    copy.setAttribute("class", "silk silk-xl");
    head.appendChild(copy);

    var who = el("div", "sp-who");
    var line = el("div", "sp-name");
    line.appendChild(el("b", "sp-pgm", "#" + (row.p || "")));
    line.appendChild(el("span", null, row.n || ""));
    who.appendChild(line);
    // The colours in words, taken from the label the drawing already carries,
    // so the panel can never describe a silk differently from the picture.
    var said = svg.getAttribute("aria-label") || "";
    if (said) { who.appendChild(el("div", "sp-colours", said)); }
    head.appendChild(who);
    box.appendChild(head);

    var nums = el("div", "sp-nums");
    [["Model", row.m], ["Fair", row.f], ["Board", row.b]].forEach(function (pair) {
      if (!pair[1]) return;
      var cell = el("div", "sp-num");
      cell.appendChild(el("b", null, pair[1]));
      cell.appendChild(el("i", null, pair[0]));
      nums.appendChild(cell);
    });
    if (nums.childNodes.length) { box.appendChild(nums); }

    if (row.a && row.a.length) {
      var list = el("ul", "sp-angles");
      row.a.forEach(function (t) { list.appendChild(el("li", null, t)); });
      box.appendChild(list);
    }

    var shut = el("button", "sp-close", "Close");
    shut.type = "button";
    shut.addEventListener("click", close);
    box.appendChild(shut);
    return box;
  }

  function clamp(v, lo, hi) {
    if (hi < lo) { return lo; }
    return Math.min(Math.max(v, lo), hi);
  }

  function place(box, svg) {
    var r = svg.getBoundingClientRect();
    var w = box.offsetWidth, h = box.offsetHeight;
    var pad = 10;
    var vw = window.innerWidth, vh = window.innerHeight;
    // Below the silk by default, above it when that would run off the bottom.
    var top = r.bottom + 8;
    if (top + h > vh - pad) { top = r.top - h - 8; }
    // Clamped unconditionally afterwards, not only in the flip. A silk can be
    // outside the viewport entirely -- a keyboard user tabbing through a long
    // field, a click fired before a scroll settles -- and both candidate
    // positions are then off-screen, which puts the panel somewhere nobody can
    // see and looks exactly like a control that does nothing.
    box.style.top = Math.round(clamp(top, pad, vh - h - pad)) + "px";
    box.style.left = Math.round(clamp(r.left - 8, pad, vw - w - pad)) + "px";
  }

  function open(svg, row) {
    close();
    backdrop = el("div", "silkveil");
    backdrop.addEventListener("click", close);
    document.body.appendChild(backdrop);
    panel = build(row, svg);
    document.body.appendChild(panel);
    place(panel, svg);
    opener = svg;
    var first = panel.querySelector(".sp-close");
    if (first) { first.focus(); }
  }

  for (var i = 0; i < silks.length; i++) {
    (function (svg) {
      var row = data[svg.getAttribute("data-r")];
      // A silk the island does not know about stays a picture. An ornament is
      // a better outcome than a control that opens nothing.
      if (!row) return;
      svg.setAttribute("role", "button");
      svg.setAttribute("tabindex", "0");
      svg.setAttribute("aria-haspopup", "dialog");
      svg.classList.add("silk-live");
      svg.addEventListener("click", function (ev) {
        ev.preventDefault(); ev.stopPropagation();
        if (opener === svg) { close(); return; }
        open(svg, row);
      });
      svg.addEventListener("keydown", function (ev) {
        if (ev.key !== "Enter" && ev.key !== " ") return;
        ev.preventDefault();
        open(svg, row);
      });
    })(silks[i]);
  }

  document.addEventListener("keydown", function (ev) {
    if (ev.key === "Escape") { close(); }
  });
  // A panel pinned to a viewport position is wrong the moment the page moves.
  window.addEventListener("resize", close);
  window.addEventListener("scroll", close, true);
})();
