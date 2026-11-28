/*
 * Liquid Glass — real refraction + chromatic aberration via SVG displacement filter.
 * Ported (framework-free) from nikdelvin/liquid-glass — MIT license.
 * https://github.com/nikdelvin/liquid-glass
 *
 * No build step, no dependencies. Apply `.liquid-glass` to a wrapper containing:
 *   .lg-overlay-bg   -> subtle tint + edge highlight (z1)
 *   .lg-content      -> your actual content (z3)
 *   .lg-filter-layer > .glass-box  -> the refracting backdrop-filter layer (z2)
 * Set data-blur / data-cab / data-depth / data-strength / data-saturate /
 * data-brightness on .glass-box, and border-radius on the wrapper.
 */
(function () {
  "use strict";

  function dataUri(svg) {
    return "data:image/svg+xml;utf8," + encodeURIComponent(svg);
  }

  /* Map that encodes the glass edge as R (horizontal) / G (vertical) displacement. */
  function displacementMap(height, width, radius, depth) {
    return dataUri(
      '<svg height="' + height + '" width="' + width + '" viewBox="0 0 ' + width + ' ' + height + '" xmlns="http://www.w3.org/2000/svg">' +
        '<style>.mix{mix-blend-mode:screen;}</style>' +
        '<defs>' +
          '<linearGradient id="Y" x1="0" x2="0" y1="' + Math.ceil((radius / height) * 15) + '%" y2="' + Math.floor(100 - (radius / height) * 15) + '%">' +
            '<stop offset="0%" stop-color="#0F0"/><stop offset="100%" stop-color="#000"/>' +
          '</linearGradient>' +
          '<linearGradient id="X" x1="' + Math.ceil((radius / width) * 15) + '%" x2="' + Math.floor(100 - (radius / width) * 15) + '%" y1="0" y2="0">' +
            '<stop offset="0%" stop-color="#F00"/><stop offset="100%" stop-color="#000"/>' +
          '</linearGradient>' +
        '</defs>' +
        '<rect x="0" y="0" height="' + height + '" width="' + width + '" fill="#808080"/>' +
        '<g filter="blur(2px)">' +
          '<rect x="0" y="0" height="' + height + '" width="' + width + '" fill="#000080"/>' +
          '<rect x="0" y="0" height="' + height + '" width="' + width + '" fill="url(#Y)" class="mix"/>' +
          '<rect x="0" y="0" height="' + height + '" width="' + width + '" fill="url(#X)" class="mix"/>' +
          '<rect x="' + depth + '" y="' + depth + '" height="' + (height - 2 * depth) + '" width="' + (width - 2 * depth) + '" fill="#808080" rx="' + radius + '" ry="' + radius + '" filter="blur(' + depth + 'px)"/>' +
        '</g>' +
      '</svg>'
    );
  }

  /* Filter that displaces R/G/B by slightly different amounts => edge color fringing. */
  function displacementFilter(height, width, radius, depth, strength, cab) {
    strength = strength || 100;
    cab = cab || 0;
    var map = displacementMap(height, width, radius, depth);
    return dataUri(
      '<svg height="' + height + '" width="' + width + '" viewBox="0 0 ' + width + ' ' + height + '" xmlns="http://www.w3.org/2000/svg">' +
        '<defs>' +
          '<filter id="displace" color-interpolation-filters="sRGB">' +
            '<feImage x="0" y="0" height="' + height + '" width="' + width + '" href="' + map + '" result="displacementMap"/>' +
            '<feDisplacementMap transform-origin="center" in="SourceGraphic" in2="displacementMap" scale="' + (strength + cab * 2) + '" xChannelSelector="R" yChannelSelector="G"/>' +
            '<feColorMatrix type="matrix" values="1 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 1 0" result="displacedR"/>' +
            '<feDisplacementMap in="SourceGraphic" in2="displacementMap" scale="' + (strength + cab) + '" xChannelSelector="R" yChannelSelector="G"/>' +
            '<feColorMatrix type="matrix" values="0 0 0 0 0  0 1 0 0 0  0 0 0 0 0  0 0 0 1 0" result="displacedG"/>' +
            '<feDisplacementMap in="SourceGraphic" in2="displacementMap" scale="' + strength + '" xChannelSelector="R" yChannelSelector="G"/>' +
            '<feColorMatrix type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 1 0 0  0 0 0 1 0" result="displacedB"/>' +
            '<feBlend in="displacedR" in2="displacedG" mode="screen"/>' +
            '<feBlend in2="displacedB" mode="screen"/>' +
          '</filter>' +
        '</defs>' +
      '</svg>'
    ) + "#displace";
  }

  function supportsUrl() {
    try {
      var t = document.createElement("div");
      t.style.cssText = "backdrop-filter:url(#test)";
      return t.style.backdropFilter === "url(#test)" || t.style.backdropFilter === 'url("#test")';
    } catch (e) {
      return false;
    }
  }

  var urlOk = supportsUrl();
  var globals = [];

  function num(el, key, fallback) {
    var v = parseFloat(el.getAttribute("data-" + key));
    return isNaN(v) ? fallback : v;
  }

  function redraw(glass) {
    var box = glass.querySelector(".glass-box");
    var content = glass.querySelector(".lg-content");
    if (!box || !content) return;
    /* Measure the whole panel, not just the inner content: padding must refract too. */
    var rect = glass.getBoundingClientRect();
    var w = Math.round(rect.width);
    var h = Math.round(rect.height);
    if (!w || !h) return;

    box.style.width = w + "px";
    box.style.height = h + "px";

    var blur = num(box, "blur", 0);
    var cab = num(box, "cab", 0);
    var depth = num(box, "depth", 12);
    var strength = num(box, "strength", 90);
    var sat = num(box, "saturate", 1.6);
    var bri = num(box, "brightness", 1.06);
    var radius = parseFloat(glass.style.borderRadius) || 24;

    var filter;
    if (urlOk) {
      filter = "blur(" + (blur / 2) + "px) url('" + displacementFilter(h, w, radius, depth, strength, cab) + "') blur(" + blur + "px) brightness(" + bri + ") saturate(" + sat + ")";
    } else {
      /* Safari/Firefox fallback: still a genuine frosted-glass blur. */
      filter = "blur(" + Math.max(12, Math.round(w / 14)) + "px) saturate(180%) brightness(" + bri + ")";
    }
    box.style.backdropFilter = filter;
    box.style.webkitBackdropFilter = filter;
  }

  function init() {
    var els = document.querySelectorAll(".liquid-glass");
    globals = Array.prototype.slice.call(els);
    globals.forEach(function (glass) {
      redraw(glass);
      if (window.ResizeObserver) {
        try {
          new ResizeObserver(function () { redraw(glass); }).observe(glass);
        } catch (e) { /* older browsers */ }
      }
    });
    window.addEventListener("resize", function () {
      globals.forEach(redraw);
    });
    /* Fonts loading can change element sizes. */
    if (document.fonts && document.fonts.ready) {
      document.fonts.ready.then(function () { globals.forEach(redraw); });
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
