import { prisma } from "@/lib/prisma";
import { NextResponse } from "next/server";

export async function GET() {
  try {
    const messages = await prisma.message.findMany({
      orderBy: {
        createdAt: "desc",
      },
      take: 20,
    });

    return NextResponse.json({ messages });
  } catch (error) {
    console.error("GET /api/messages failed", error);
    return NextResponse.json(
      { error: "The database is not configured yet, so messages cannot be loaded." },
      { status: 500 },
    );
  }
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as { content?: string };
    const content = body.content?.trim();

    if (!content) {
      return NextResponse.json({ error: "content cannot be empty." }, { status: 400 });
    }

    const message = await prisma.message.create({
      data: {
        content,
      },
    });

    return NextResponse.json({ message }, { status: 201 });
  } catch (error) {
    console.error("POST /api/messages failed", error);
    return NextResponse.json(
      { error: "The database is not configured yet, so the message cannot be saved." },
      { status: 500 },
    );
  }
}
