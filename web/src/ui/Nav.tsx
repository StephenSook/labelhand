"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { Mark } from "./Mark";

const links = [
  { href: "/", label: "Home" },
  { href: "/app", label: "Plan a tank" },
  { href: "/judge", label: "Judges" },
];

export function Nav() {
  const previousY = useRef(0);
  const [hidden, setHidden] = useState(false);

  useEffect(() => {
    previousY.current = window.scrollY;
    const onScroll = () => {
      const nextY = window.scrollY;
      setHidden(nextY > 96 && nextY > previousY.current + 4);
      previousY.current = nextY;
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  return (
    <header className={`site-nav ${hidden ? "site-nav-hidden" : ""}`}>
      <Link className="brand-pill" href="/" aria-label="Labelhand home">
        <Mark size={30} />
        <span className="display">Labelhand</span>
      </Link>
      <nav aria-label="Main navigation" className="nav-pills">
        {links.map((link) => (
          <Link className="nav-pill" href={link.href} key={link.href}>
            {link.label}
          </Link>
        ))}
      </nav>
    </header>
  );
}
