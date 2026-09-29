import { useEffect, useRef, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { ChevronDown, Package, Plus, Store } from "lucide-react";

export function SellerMenu() {
  const [open, setOpen] = useState(false);
  const menu = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const location = useLocation();
  const active = ["/sales", "/offers", "/create"].some(path =>
    location.pathname === path || location.pathname.startsWith(`${path}/`),
  );

  useEffect(() => {
    const outside = (event: PointerEvent) => {
      if (!menu.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, []);

  return <div
    className="seller-menu"
    ref={menu}
    onMouseEnter={() => setOpen(true)}
    onMouseLeave={() => setOpen(false)}
    onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOpen(false); }}
    onKeyDown={event => {
      if (event.key === "Escape") {
        setOpen(false);
        trigger.current?.focus();
      }
    }}
  >
    <button
      className={`seller-menu-trigger${active ? " active" : ""}`}
      type="button"
      ref={trigger}
      aria-label="Seller menu"
      aria-haspopup="true"
      aria-expanded={open}
      aria-current={active ? "page" : undefined}
      onClick={() => setOpen(value => !value)}
    >
      <Store aria-hidden="true" />Seller<ChevronDown className="seller-menu-chevron" aria-hidden="true" />
    </button>
    {open && <div className="seller-submenu" aria-label="Seller">
      <Link className="seller-submenu-link" to="/sales" onClick={() => setOpen(false)}><Package aria-hidden="true" />Sales</Link>
      <Link className="seller-submenu-link" to="/offers" onClick={() => setOpen(false)}><Store aria-hidden="true" />My Offers</Link>
      <Link className="seller-submenu-link" to="/create" onClick={() => setOpen(false)}><Plus aria-hidden="true" />New Offer</Link>
    </div>}
  </div>;
}
