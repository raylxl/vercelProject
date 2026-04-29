import { prisma } from "@/lib/prisma";
import { MessageForm } from "./message-form";

export const dynamic = "force-dynamic";

type MessageRecord = {
  id: number;
  content: string;
  createdAt: Date;
};

async function getMessages(): Promise<MessageRecord[] | null> {
  try {
    return await prisma.message.findMany({
      orderBy: {
        createdAt: "desc",
      },
      take: 8,
    });
  } catch (error) {
    console.error("Failed to load messages", error);
    return null;
  }
}

export default async function HomePage() {
  const messages = await getMessages();

  return (
    <main className="page-shell">
      <section className="hero panel">
        <span className="eyebrow">Vercel Fullstack Starter</span>
        <h1>Frontend, backend, and PostgreSQL wired into one Vercel project</h1>
        <p className="hero-copy">
          This starter uses Next.js App Router for the frontend, Route Handlers for the
          backend API, and Prisma for PostgreSQL access. Push it to Git and import the
          repository into Vercel to deploy.
        </p>

        <div className="hero-grid">
          <div>
            <span className="metric-label">Frontend</span>
            <strong>Next.js pages</strong>
          </div>
          <div>
            <span className="metric-label">Backend</span>
            <strong>`/api/messages`</strong>
          </div>
          <div>
            <span className="metric-label">Database</span>
            <strong>PostgreSQL + Prisma</strong>
          </div>
        </div>
      </section>

      <section className="content-grid">
        <MessageForm />

        <div className="panel">
          <div className="panel-heading">
            <span className="eyebrow">Database Reads</span>
            <h2>Recently saved messages</h2>
          </div>

          {messages === null ? (
            <div className="empty-state">
              <p>The database is not connected yet.</p>
              <p>
                Set <code>DATABASE_URL</code> locally or in Vercel, then run the Prisma
                migration.
              </p>
            </div>
          ) : messages.length === 0 ? (
            <div className="empty-state">
              <p>The database is reachable, but there is no data yet.</p>
              <p>Create a message with the form to test the full request flow.</p>
            </div>
          ) : (
            <ul className="message-list">
              {messages.map((message) => (
                <li key={message.id}>
                  <p>{message.content}</p>
                  <time dateTime={message.createdAt.toISOString()}>
                    {message.createdAt.toLocaleString("zh-CN")}
                  </time>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>
    </main>
  );
}
