(function () {
  "use strict";
  var root = document.querySelector("[data-verify]");
  if (!root || !window.crypto || !window.crypto.subtle || !window.FileReader) return;

  var expected = (root.getAttribute("data-verify") || "").toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(expected)) return;

  var zone = document.createElement("div");
  zone.className = "vz";
  zone.setAttribute("tabindex", "0");
  zone.setAttribute("role", "button");
  zone.setAttribute("aria-label", "Verify card.json: choose a file or drop one here");
  zone.innerHTML =
    '<span class="vz-msg">Drop <code>card.json</code> here, or ' +
    '<label class="vz-pick">choose it<input type="file" accept="application/json,.json"></label>' +
    '. It is hashed in your browser; nothing is uploaded.</span>';
  root.appendChild(zone);

  var input = zone.querySelector("input[type=file]");

  function say(cls, msg) {
    zone.className = "vz " + cls;
    zone.querySelector(".vz-msg").textContent = msg;
    zone.setAttribute("aria-live", "polite");
  }

  function hex(buf) {
    var b = new Uint8Array(buf), s = "";
    for (var i = 0; i < b.length; i++) s += b[i].toString(16).padStart(2, "0");
    return s;
  }

  function check(file) {
    if (!file) return;
    say("vz-busy", "Hashing " + file.name + "\u2026");
    var r = new FileReader();
    r.onerror = function () { say("vz-bad", "Could not read that file."); };
    r.onload = function () {
      window.crypto.subtle.digest("SHA-256", r.result).then(function (d) {
        var got = hex(d);
        if (got === expected) {
          say("vz-ok", "Match. This is the file that was hashed before post: " +
              got.slice(0, 16) + "\u2026");
        } else {
          say("vz-bad", "No match. That file hashes to " + got.slice(0, 16) +
              "\u2026 and this card committed to " + expected.slice(0, 16) + "\u2026");
        }
      }).catch(function () { say("vz-bad", "Your browser refused to hash the file."); });
    };
    r.readAsArrayBuffer(file);
  }

  input.addEventListener("change", function () { check(this.files && this.files[0]); });
  zone.addEventListener("keydown", function (e) {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); input.click(); }
  });
  ["dragenter", "dragover"].forEach(function (ev) {
    zone.addEventListener(ev, function (e) {
      e.preventDefault(); zone.classList.add("vz-over");
    });
  });
  ["dragleave", "drop"].forEach(function (ev) {
    zone.addEventListener(ev, function (e) {
      e.preventDefault(); zone.classList.remove("vz-over");
    });
  });
  zone.addEventListener("drop", function (e) {
    check(e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]);
  });
})();
