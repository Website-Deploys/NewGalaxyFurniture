/* ===================== New Galaxy Furniture — front page ===================== */
(function () {
  "use strict";

  const $ = (sel, ctx = document) => ctx.querySelector(sel);
  const $$ = (sel, ctx = document) => Array.from(ctx.querySelectorAll(sel));

  /* ---------- Footer year ---------- */
  const yearEl = $("#year");
  if (yearEl) yearEl.textContent = new Date().getFullYear();

  /* ---------- Mobile menu toggle ---------- */
  const navToggle = $("#navToggle");
  const navPill = $(".nav-pill");
  if (navToggle && navPill) {
    navToggle.addEventListener("click", () => {
      const open = navPill.classList.toggle("open");
      navToggle.setAttribute("aria-expanded", String(open));
    });
  }

  /* ---------- Shop dropdown ---------- */
  const dropdownToggle = $(".dropdown-toggle");
  const dropdownParent = dropdownToggle ? dropdownToggle.closest(".has-dropdown") : null;
  if (dropdownToggle && dropdownParent) {
    dropdownToggle.addEventListener("click", (e) => {
      e.stopPropagation();
      const open = dropdownParent.classList.toggle("open");
      dropdownToggle.setAttribute("aria-expanded", String(open));
    });
    document.addEventListener("click", (e) => {
      if (!dropdownParent.contains(e.target)) {
        dropdownParent.classList.remove("open");
        dropdownToggle.setAttribute("aria-expanded", "false");
      }
    });
  }

  /* ---------- Close mobile menu when a link is clicked ---------- */
  $$(".nav-links a").forEach((a) =>
    a.addEventListener("click", () => {
      navPill && navPill.classList.remove("open");
      navToggle && navToggle.setAttribute("aria-expanded", "false");
    })
  );

  /* ---------- Hide header on scroll down, show on scroll up ---------- */
  const header = $("#siteHeader");
  let lastY = window.scrollY;
  if (header) {
    window.addEventListener(
      "scroll",
      () => {
        const y = window.scrollY;
        if (y > lastY && y > 200) header.classList.add("hide");
        else header.classList.remove("hide");
        lastY = y;
      },
      { passive: true }
    );
  }

  /* ---------- Search ---------- */
  const searchForm = $("#searchForm");
  const searchInput = $("#searchInput");
  if (searchForm) {
    searchForm.addEventListener("submit", (e) => {
      e.preventDefault();
      const q = (searchInput && searchInput.value.trim()) || "";
      if (!q) {
        searchInput && searchInput.focus();
        return;
      }
      // No backend on a static site — acknowledge the query.
      alert('Searching for "' + q + '"\u2026\nOur catalogue search will connect here.');
    });
  }

  /* ---------- Enquiry modal ---------- */
  const overlay = $("#modalOverlay");
  const modalClose = $("#modalClose");
  const modalTitle = $("#modalTitle");
  const modalSub = $("#modalSub");
  const enquiryForm = $("#enquiryForm");
  const modalSuccess = $("#modalSuccess");
  let lastFocused = null;

  function openModal(title, sub) {
    if (!overlay) return;
    if (title && modalTitle) modalTitle.textContent = title;
    if (sub && modalSub) modalSub.textContent = sub;
    if (enquiryForm) enquiryForm.hidden = false;
    if (modalSuccess) modalSuccess.hidden = true;
    lastFocused = document.activeElement;
    overlay.classList.add("open");
    overlay.setAttribute("aria-hidden", "false");
    const firstInput = overlay.querySelector("input, textarea");
    if (firstInput) setTimeout(() => firstInput.focus(), 120);
  }

  function closeModal() {
    if (!overlay) return;
    overlay.classList.remove("open");
    overlay.setAttribute("aria-hidden", "true");
    if (lastFocused && lastFocused.focus) lastFocused.focus();
  }

  // Buttons that open the modal, each with tailored copy.
  const modalTriggers = [
    { id: "#enquireBtn", title: "Start an enquiry", sub: "Tell us what you have in mind and we will get back to you." },
    { id: "#footerEnquireBtn", title: "Start an enquiry", sub: "Tell us what you have in mind and we will get back to you." },
    { id: "#storyEnquiryBtn", title: "Tell us your story", sub: "The piece, the room it\u2019s for, the timber or finish you prefer \u2014 and we\u2019ll come back with options, timelines and prices." },
    { id: "#customEnquiryBtn", title: "Start a custom enquiry", sub: "Send us a size, sketch or photo and we\u2019ll tell you what\u2019s possible." },
    { id: "#planVisitBtn", title: "Plan a visit", sub: "Let us know when you\u2019d like to come and what you\u2019d like to see." },
  ];
  modalTriggers.forEach((t) => {
    const btn = $(t.id);
    if (btn) btn.addEventListener("click", () => openModal(t.title, t.sub));
  });

  if (modalClose) modalClose.addEventListener("click", closeModal);
  if (overlay) {
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) closeModal();
    });
  }
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && overlay && overlay.classList.contains("open")) closeModal();
  });

  if (enquiryForm) {
    enquiryForm.addEventListener("submit", (e) => {
      e.preventDefault();
      enquiryForm.hidden = true;
      if (modalSuccess) modalSuccess.hidden = false;
      enquiryForm.reset();
      setTimeout(closeModal, 2200);
    });
  }

  /* ---------- Scroll reveal animations ---------- */
  const reveals = $$(".reveal");
  if ("IntersectionObserver" in window && reveals.length) {
    const io = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            entry.target.classList.add("in-view");
            io.unobserve(entry.target);
          }
        });
      },
      { threshold: 0.15, rootMargin: "0px 0px -8% 0px" }
    );
    reveals.forEach((el) => io.observe(el));
  } else {
    reveals.forEach((el) => el.classList.add("in-view"));
  }
})();
