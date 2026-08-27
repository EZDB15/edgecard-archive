(function () {
  "use strict";
  var bar = document.querySelector("[role='tablist'].ectabs");
  var panes = document.querySelectorAll("[data-tabpane]");
  if (!bar || !panes.length) return;

  var buttons = bar.querySelectorAll(".ectab");
  if (!buttons.length) return;

  function names() {
    var out = [];
    for (var i = 0; i < buttons.length; i++) {
      out.push(buttons[i].getAttribute("data-tab"));
    }
    return out;
  }

  function show(name, push) {
    var known = names();
    if (known.indexOf(name) === -1) { name = known[0]; }
    for (var i = 0; i < panes.length; i++) {
      var mine = panes[i].getAttribute("data-tabpane") === name;
      panes[i].hidden = !mine;
    }
    for (var j = 0; j < buttons.length; j++) {
      var on = buttons[j].getAttribute("data-tab") === name;
      buttons[j].classList.toggle("ectab-on", on);
      buttons[j].setAttribute("aria-selected", on ? "true" : "false");
      buttons[j].setAttribute("tabindex", on ? "0" : "-1");
    }
    if (push && window.history && window.history.replaceState) {
      try { window.history.replaceState(null, "", "#" + name); } catch (e) {}
    }
  }

  for (var i = 0; i < buttons.length; i++) {
    (function (b) {
      b.addEventListener("click", function () {
        show(b.getAttribute("data-tab"), true);
        // Scrolling to the top of the panel, not the page: the masthead and
        // the status strip sit above the tabs and are context for every
        // screen, so throwing the reader to the very top loses their place.
        var top = bar.getBoundingClientRect().top + window.pageYOffset - 12;
        if (window.pageYOffset > top) { window.scrollTo(0, top); }
      });
      // Arrow keys move between tabs, which is what a tablist is expected to
      // do and costs six lines.
      b.addEventListener("keydown", function (ev) {
        var order = names();
        var at = order.indexOf(b.getAttribute("data-tab"));
        var next = ev.key === "ArrowRight" ? at + 1
                 : ev.key === "ArrowLeft" ? at - 1 : -1;
        if (next < 0 || next >= order.length) return;
        ev.preventDefault();
        show(order[next], true);
        buttons[next].focus();
      });
    })(buttons[i]);
  }

  window.addEventListener("hashchange", function () {
    show((location.hash || "").replace("#", ""), false);
  });

  // A browser's find cannot see a hidden panel, and Ctrl+F is how a reader
  // looks for a horse. Rather than guess at intercepting the keystroke, the
  // page offers a way back: one control that drops the tabs and shows
  // everything, which is also the honest fallback for anyone the tabs are
  // simply not helping.
  var all = document.createElement("button");
  all.type = "button";
  all.className = "ectab-all";
  // Short on purpose. At the card column width the longer label did not
  // fit beside four tabs, wrapped onto its own line and sat there looking
  // like an accident. The tooltip carries the full sentence.
  all.textContent = "Show everything";
  all.title = "Show every screen on one page";
  all.addEventListener("click", function () {
    for (var i = 0; i < panes.length; i++) { panes[i].hidden = false; }
    for (var j = 0; j < buttons.length; j++) {
      buttons[j].classList.remove("ectab-on");
      buttons[j].setAttribute("aria-selected", "false");
    }
    all.hidden = true;
  });
  bar.appendChild(all);

  show((location.hash || "").replace("#", "") || "__first", false);
  bar.removeAttribute("hidden");
})();
