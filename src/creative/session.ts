import { promises as fs } from 'fs';
import { join } from 'path';
import { CreativeSession, CreativeInput, ImagePrompt, CreativeEdit } from './types.ts';

export class SessionManager {
  private sessionsDir: string;

  constructor(baseDir: string = '.kondi-chat/creative') {
    this.sessionsDir = baseDir;
  }

  async ensureDir(): Promise<void> {
    await fs.mkdir(this.sessionsDir, { recursive: true });
  }

  async createSession(input: CreativeInput): Promise<CreativeSession> {
    await this.ensureDir();
    
    const session: CreativeSession = {
      id: crypto.randomUUID(),
      input,
      currentPrompt: { prompt: '' },
      history: [],
      createdAt: new Date(),
      updatedAt: new Date()
    };

    await this.saveSession(session);
    return session;
  }

  async getSession(id: string): Promise<CreativeSession | null> {
    try {
      const path = join(this.sessionsDir, `${id}.json`);
      const content = await fs.readFile(path, 'utf-8');
      const data = JSON.parse(content);
      
      // Restore date objects
      return {
        ...data,
        createdAt: new Date(data.createdAt),
        updatedAt: new Date(data.updatedAt),
        history: data.history.map((edit: any) => ({
          ...edit,
          timestamp: new Date(edit.timestamp)
        }))
      };
    } catch {
      return null;
    }
  }

  async saveSession(session: CreativeSession): Promise<void> {
    const path = join(this.sessionsDir, `${session.id}.json`);
    await fs.writeFile(path, JSON.stringify(session, null, 2));
  }

  async updatePrompt(
    session: CreativeSession, 
    newPrompt: ImagePrompt,
    instruction?: string
  ): Promise<CreativeSession> {
    if (instruction && session.currentPrompt.prompt) {
      // Save edit to history
      const edit: CreativeEdit = {
        instruction,
        previousPrompt: session.currentPrompt,
        newPrompt,
        timestamp: new Date()
      };
      session.history.push(edit);
    }

    session.currentPrompt = newPrompt;
    session.updatedAt = new Date();
    
    await this.saveSession(session);
    return session;
  }

  async listSessions(): Promise<string[]> {
    await this.ensureDir();
    const files = await fs.readdir(this.sessionsDir);
    return files
      .filter(f => f.endsWith('.json'))
      .map(f => f.replace('.json', ''));
  }
}