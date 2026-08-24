/**
 * ui.js
 * 모든 페이지가 공유하는 화면 연출.
 * 지금은 스크롤 페이드인 하나뿐이며, 기능 로직과 분리해 둔다.
 */
(function () {
  'use strict';

  var targets = document.querySelectorAll('.reveal');
  if (!targets.length) return;

  // 모션을 줄이도록 설정한 사용자에게는 애니메이션 없이 바로 보여준다
  var reduceMotion = window.matchMedia &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  if (reduceMotion || !('IntersectionObserver' in window)) {
    targets.forEach(function (el) { el.classList.add('in'); });
    return;
  }

  var observer = new IntersectionObserver(function (entries) {
    entries.forEach(function (entry) {
      // 한 번 나타난 뒤에는 다시 사라지지 않게 해서 조작 중 깜빡임을 막는다
      if (entry.isIntersecting) {
        entry.target.classList.add('in');
        observer.unobserve(entry.target);
      }
    });
  }, { rootMargin: '0px 0px -8% 0px', threshold: 0.06 });

  targets.forEach(function (el) { observer.observe(el); });
})();
