import Link from "next/link";

export default function NotFound() {
    return (
        <div
            style={{
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                justifyContent: "center",
                minHeight: "60vh",
                textAlign: "center",
                padding: "2rem",
            }}
        >
            <h1 style={{ fontSize: "4rem", fontWeight: 700, margin: 0 }}>404</h1>
            <p style={{ fontSize: "1.25rem", marginTop: "0.5rem", opacity: 0.7 }}>
                This page could not be found.
            </p>
            <Link
                href="/en/general"
                style={{
                    marginTop: "1.5rem",
                    padding: "0.5rem 1.5rem",
                    borderRadius: "0.5rem",
                    background: "var(--fd-primary)",
                    color: "var(--fd-primary-foreground, #fff)",
                    textDecoration: "none",
                    fontWeight: 500,
                }}
            >
                Go to Docs
            </Link>
        </div>
    );
}
