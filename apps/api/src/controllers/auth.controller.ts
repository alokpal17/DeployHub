import { Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { UserModel } from '../models';
import { config } from '../config';

function signToken(userId: string): string {
  return jwt.sign({ userId }, config.jwt.secret, {
    expiresIn: config.jwt.expiresIn,
  } as jwt.SignOptions);
}

// POST /api/auth/register  (demo: no GitHub OAuth, just username/password)
export async function register(req: Request, res: Response): Promise<void> {
  try {
    const { username, email } = req.body;

    if (!username || !email) {
      res.status(400).json({ success: false, error: 'username and email required' });
      return;
    }

    const existing = await UserModel.findOne({ email });
    if (existing) {
      res.status(409).json({ success: false, error: 'Email already registered' });
      return;
    }

    const user = await UserModel.create({
      githubId: `local_${Date.now()}`,
      username,
      email,
      avatarUrl: `https://api.dicebear.com/7.x/initials/svg?seed=${username}`,
    });

    const token = signToken(user._id.toString());
    res.status(201).json({ success: true, data: { token, user } });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Registration failed' });
  }
}

// POST /api/auth/login
export async function login(req: Request, res: Response): Promise<void> {
  try {
    const { email } = req.body;

    if (!email) {
      res.status(400).json({ success: false, error: 'email required' });
      return;
    }

    const user = await UserModel.findOne({ email });
    if (!user) {
      res.status(404).json({ success: false, error: 'User not found' });
      return;
    }

    const token = signToken(user._id.toString());
    res.json({ success: true, data: { token, user } });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Login failed' });
  }
}

// GET /api/auth/me
export async function getMe(req: Request & { userId?: string }, res: Response): Promise<void> {
  try {
    const user = await UserModel.findById(req.userId).select('-__v');
    if (!user) {
      res.status(404).json({ success: false, error: 'User not found' });
      return;
    }
    res.json({ success: true, data: user });
  } catch {
    res.status(500).json({ success: false, error: 'Failed to fetch user' });
  }
}
