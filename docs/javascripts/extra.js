window.addEventListener("scroll", () => {
  const header = document.querySelector(".md-header");
  if (window.scrollY > 10) {
    header.classList.add("scrolled");
  } else {
    header.classList.remove("scrolled");
  }
});
