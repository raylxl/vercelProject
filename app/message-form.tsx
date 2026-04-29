"use client";

import { useRouter } from "next/navigation";
import { FormEvent, useState } from "react";

export function MessageForm() {
  const router = useRouter();
  const [content, setContent] = useState("");
  const [status, setStatus] = useState<string>("");
  const [pending, setPending] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const value = content.trim();
    if (!value) {
      setStatus("Please enter a message.");
      return;
    }

    setPending(true);
    setStatus("");

    try {
      const response = await fetch("/api/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ content: value }),
      });

      if (!response.ok) {
        const data = (await response.json().catch(() => null)) as
          | { error?: string }
          | null;

        throw new Error(data?.error ?? "Failed to save the message.");
      }

      setContent("");
      setStatus("Saved to the database.");
      router.refresh();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Request failed. Please try again.");
    } finally {
      setPending(false);
    }
  }

  return (
    <form className="panel form-panel" onSubmit={handleSubmit}>
      <div className="panel-heading">
        <span className="eyebrow">Write Data</span>
        <h2>Create a message through the API</h2>
      </div>

      <label className="field">
        <span>Content</span>
        <input
          name="content"
          placeholder="Example: Vercel full-stack deployment works"
          value={content}
          onChange={(event) => setContent(event.target.value)}
          maxLength={120}
        />
      </label>

      <div className="form-actions">
        <button type="submit" disabled={pending}>
          {pending ? "Saving..." : "Save message"}
        </button>
        <p className="status">{status || " "}</p>
      </div>
    </form>
  );
}
