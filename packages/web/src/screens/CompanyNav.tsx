import { hrefContacts, hrefJobs, hrefLibrary } from "../route.js";

export type CompanyPage = "register" | "library" | "enquiries" | "contacts";

/** The company-level navigator down the left of the dashboard pages: the register, the resource library, enquiries and contacts. */
export function CompanyNav({ current }: { current: CompanyPage }) {
  const link = (page: CompanyPage, href: string, label: string) => (
    <a href={href} className={current === page ? "active" : ""} aria-current={current === page ? "page" : undefined}>{label}</a>
  );
  return (
    <nav className="nav" aria-label="Company">
      <h6>Company</h6>
      {link("register", hrefJobs(), "Tender Register")}
      {link("library", hrefLibrary(), "Resource Library")}
      {link("enquiries", hrefContacts("enquiries"), "Enquiries")}
      {link("contacts", hrefContacts("contacts"), "Contacts")}
    </nav>
  );
}
