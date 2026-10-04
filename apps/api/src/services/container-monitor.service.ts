import { exec } from 'child_process';
import { promisify } from 'util';
import type { ContainerResourceStats } from '@deployhub/shared';
import { DeploymentModel, ProjectModel } from '../models';
import {
  containerCpuUsageGauge,
  containerMemoryUsageGauge,
  containerMemoryLimitGauge,
} from './metrics.service';

const execAsync = promisify(exec);

export class ContainerMonitorService {
  /**
   * Fetches real-time resource statistics for an active project container
   */
  static async getProjectContainerStats(projectId: string): Promise<ContainerResourceStats | null> {
    try {
      const project = await ProjectModel.findById(projectId);
      if (!project) return null;

      // Find active deployment
      let activeDep = null;
      if (project.activeDeploymentId) {
        activeDep = await DeploymentModel.findById(project.activeDeploymentId);
      }
      if (!activeDep) {
        activeDep = await DeploymentModel.findOne({
          projectId,
          status: { $in: ['RUNNING', 'ACTIVE'] },
        }).sort({ startedAt: -1 });
      }

      if (!activeDep || !activeDep.containerId) {
        return null;
      }

      const containerId = activeDep.containerId;

      // 1. Inspect container running status & uptime
      const { stdout: inspectOut } = await execAsync(
        `docker inspect -f "{{.State.Status}} {{.State.StartedAt}} {{.Name}}" ${containerId}`
      ).catch(() => ({ stdout: '' }));

      if (!inspectOut.trim()) {
        return null;
      }

      const [status, startedAtStr, nameRaw] = inspectOut.trim().split(' ');
      const containerName = (nameRaw || '').replace(/^\//, '');

      let uptimeSeconds = 0;
      if (startedAtStr) {
        uptimeSeconds = Math.max(0, Math.floor((Date.now() - new Date(startedAtStr).getTime()) / 1000));
      }

      // 2. Fetch live stats via docker stats
      let cpuPercentage = 0;
      let memoryUsageBytes = 0;
      let memoryLimitBytes = 512 * 1024 * 1024; // Default 512MB
      let memoryPercentage = 0;
      let networkRxBytes = 0;
      let networkTxBytes = 0;

      try {
        const { stdout: statsOut } = await execAsync(
          `docker stats ${containerId} --no-stream --format "{{.CPUPerc}} {{.MemUsage}} {{.MemPerc}} {{.NetIO}}"`
        );
        const statsLine = statsOut.trim();
        if (statsLine) {
          const parts = statsLine.split(' ');
          // CPU e.g. "0.15%"
          cpuPercentage = parseFloat((parts[0] || '0').replace('%', '')) || 0;

          // Mem e.g. "25.5MiB / 512MiB"
          const memRaw = parts[1] || '0MiB';
          memoryUsageBytes = this.parseBytes(memRaw);

          const limitRaw = parts[3] || '512MiB';
          memoryLimitBytes = this.parseBytes(limitRaw);

          // Mem % e.g. "4.98%"
          memoryPercentage = parseFloat((parts[4] || '0').replace('%', '')) || 0;

          // Net e.g. "1.2kB / 3.4kB"
          const netRxRaw = parts[5] || '0B';
          const netTxRaw = parts[7] || '0B';
          networkRxBytes = this.parseBytes(netRxRaw);
          networkTxBytes = this.parseBytes(netTxRaw);
        }
      } catch {
        // Stats parsing best effort
      }

      // Update Prometheus Gauges
      try {
        containerCpuUsageGauge.set({ project_id: projectId, container_name: containerName }, cpuPercentage);
        containerMemoryUsageGauge.set({ project_id: projectId, container_name: containerName }, memoryUsageBytes);
        containerMemoryLimitGauge.set({ project_id: projectId, container_name: containerName }, memoryLimitBytes);
      } catch {}

      return {
        projectId,
        deploymentId: activeDep._id.toString(),
        containerId,
        containerName,
        status: status || 'running',
        cpuPercentage,
        memoryUsageBytes,
        memoryLimitBytes,
        memoryPercentage,
        networkRxBytes,
        networkTxBytes,
        uptimeSeconds,
        restartCount: activeDep.restartCount || 0,
      };
    } catch (err: any) {
      console.warn(`[ContainerMonitor] Failed to fetch stats for project ${projectId}:`, err.message);
      return null;
    }
  }

  /**
   * Helper to parse human-readable byte sizes (e.g. 25.5MiB, 1.2GB, 500kB) to numeric bytes
   */
  private static parseBytes(raw: string): number {
    if (!raw) return 0;
    const clean = raw.trim().toUpperCase();
    const val = parseFloat(clean) || 0;
    if (clean.includes('GIB') || clean.includes('GB')) return Math.round(val * 1024 * 1024 * 1024);
    if (clean.includes('MIB') || clean.includes('MB')) return Math.round(val * 1024 * 1024);
    if (clean.includes('KIB') || clean.includes('KB')) return Math.round(val * 1024);
    return Math.round(val);
  }
}
