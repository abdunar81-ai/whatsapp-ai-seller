import { db, now } from "../db.js";

export interface QuestionRow {
  id: number;
  chat_id: string;
  customer_name: string | null;
  question: string;
  status: "open" | "answered" | "dismissed";
  answer: string | null;
  created_at: string;
  answered_at: string | null;
}

export interface KnowledgeRow {
  id: number;
  question: string;
  answer: string;
  created_at: string;
  updated_at: string;
}

export function createQuestion(chatId: string, customerName: string | undefined, question: string): QuestionRow {
  const r = db
    .prepare("INSERT INTO questions (chat_id, customer_name, question, created_at) VALUES (?, ?, ?, ?)")
    .run(chatId, customerName ?? null, question, now());
  return getQuestion(Number(r.lastInsertRowid))!;
}

export function openQuestionsFor(chatId: string): QuestionRow[] {
  return db
    .prepare("SELECT * FROM questions WHERE chat_id = ? AND status = 'open' ORDER BY id")
    .all(chatId) as unknown as QuestionRow[];
}

export function getQuestion(id: number): QuestionRow | undefined {
  return db.prepare("SELECT * FROM questions WHERE id = ?").get(id) as QuestionRow | undefined;
}

export function listQuestions(status?: string): QuestionRow[] {
  return (
    status
      ? db.prepare("SELECT * FROM questions WHERE status = ? ORDER BY id DESC LIMIT 500").all(status)
      : db.prepare("SELECT * FROM questions ORDER BY id DESC LIMIT 500").all()
  ) as unknown as QuestionRow[];
}

export function openQuestionCount(): number {
  return (db.prepare("SELECT COUNT(*) n FROM questions WHERE status = 'open'").get() as { n: number }).n;
}

export function answerQuestion(id: number, answer: string): void {
  db.prepare("UPDATE questions SET status = 'answered', answer = ?, answered_at = ? WHERE id = ?").run(answer, now(), id);
}

export function dismissQuestion(id: number): void {
  db.prepare("UPDATE questions SET status = 'dismissed', answered_at = ? WHERE id = ?").run(now(), id);
}

// --- knowledge base: Q&A the bot may use in answers ---

export function listKnowledge(): KnowledgeRow[] {
  return db.prepare("SELECT * FROM knowledge ORDER BY id").all() as unknown as KnowledgeRow[];
}

export function addKnowledge(question: string, answer: string): KnowledgeRow {
  const t = now();
  const r = db
    .prepare("INSERT INTO knowledge (question, answer, created_at, updated_at) VALUES (?, ?, ?, ?)")
    .run(question, answer, t, t);
  return db.prepare("SELECT * FROM knowledge WHERE id = ?").get(Number(r.lastInsertRowid)) as unknown as KnowledgeRow;
}

export function updateKnowledge(id: number, question: string, answer: string): void {
  db.prepare("UPDATE knowledge SET question = ?, answer = ?, updated_at = ? WHERE id = ?").run(question, answer, now(), id);
}

export function deleteKnowledge(id: number): void {
  db.prepare("DELETE FROM knowledge WHERE id = ?").run(id);
}

/** The knowledge base as text for the bot's instructions (stable order keeps the prompt cache warm). */
export function knowledgeText(): string {
  return listKnowledge()
    .map((k) => `Сұрақ / Вопрос: ${k.question}\nЖауап / Ответ: ${k.answer}`)
    .join("\n\n");
}
