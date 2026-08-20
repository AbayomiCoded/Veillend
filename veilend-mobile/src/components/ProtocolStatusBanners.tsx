import React from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { getProtocolStatusBanners, ProtocolStatusBannerId } from '../utils/protocolStatus';

type ProtocolStatusBannersProps = {
  expectedNetwork: string;
  currentNetwork?: string | null;
  walletConnected: boolean;
  lastSyncedAt?: number | null;
  isRefreshing?: boolean;
  isOnline?: boolean;
  // True once a dashboard fetch has timed out (issue #344) — surfaces a
  // dismissible warning banner instead of just leaving the user to notice
  // the error screen on their own.
  backendSlow?: boolean;
  onReconnect: () => void;
  onRetrySync: () => void;
  // Called when the user dismisses a `dismissible` banner (currently only
  // `backend-slow`). The caller owns clearing the underlying state.
  onDismiss?: (id: ProtocolStatusBannerId) => void;
};

export default function ProtocolStatusBanners({
  expectedNetwork,
  currentNetwork,
  walletConnected,
  lastSyncedAt,
  isRefreshing = false,
  isOnline = true,
  backendSlow = false,
  onReconnect,
  onRetrySync,
  onDismiss,
}: ProtocolStatusBannersProps) {
  const banners = getProtocolStatusBanners({
    expectedNetwork,
    currentNetwork,
    walletConnected,
    lastSyncedAt,
    isOnline,
    backendSlow,
  });

  if (banners.length === 0) {
    return null;
  }

  return (
    <View style={styles.stack}>
      {banners.map((banner) => {
        const isWalletBanner = banner.id === 'wallet-disconnected';
        const isOfflineBanner = banner.id === 'offline';
        const isBackendSlowBanner = banner.id === 'backend-slow';
        const onPress = isWalletBanner ? onReconnect : onRetrySync;
        const iconName = isWalletBanner
          ? 'wallet-outline'
          : isOfflineBanner
            ? 'cloud-offline-outline'
            : isBackendSlowBanner
              ? 'time-outline'
              : 'warning-outline';

        return (
          <View
            key={banner.id}
            style={[
              styles.banner,
              banner.severity === 'danger' ? styles.danger : styles.warning,
            ]}
          >
            <Ionicons name={iconName} size={20} color="#FFFFFF" />
            <View style={styles.copy}>
              <Text style={styles.title}>{banner.title}</Text>
              <Text style={styles.message}>{banner.message}</Text>
            </View>
            {banner.actionLabel ? (
              <TouchableOpacity
                accessibilityRole="button"
                accessibilityLabel={banner.actionLabel}
                accessibilityHint={isWalletBanner ? 'Reconnect your wallet' : 'Retry protocol status sync'}
                disabled={isRefreshing && !isWalletBanner}
                onPress={onPress}
                style={styles.action}
              >
                <Text style={styles.actionText}>
                  {isRefreshing && !isWalletBanner ? 'Checking...' : banner.actionLabel}
                </Text>
              </TouchableOpacity>
            ) : null}
            {banner.dismissible ? (
              <TouchableOpacity
                accessibilityRole="button"
                accessibilityLabel={`Dismiss: ${banner.title}`}
                onPress={() => onDismiss?.(banner.id)}
                style={styles.dismiss}
                hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
              >
                <Ionicons name="close" size={18} color="rgba(255,255,255,0.7)" />
              </TouchableOpacity>
            ) : null}
          </View>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  stack: {
    gap: 10,
    marginBottom: 18,
  },
  banner: {
    alignItems: 'center',
    borderRadius: 16,
    flexDirection: 'row',
    gap: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  danger: {
    backgroundColor: '#7F1D1D',
    borderColor: '#EF4444',
    borderWidth: 1,
  },
  warning: {
    backgroundColor: '#3B2F0B',
    borderColor: '#EAB308',
    borderWidth: 1,
  },
  copy: {
    flex: 1,
  },
  title: {
    color: '#FFFFFF',
    fontSize: 14,
    fontWeight: '700',
    marginBottom: 2,
  },
  message: {
    color: 'rgba(255,255,255,0.78)',
    fontSize: 12,
    lineHeight: 16,
  },
  action: {
    backgroundColor: 'rgba(255,255,255,0.14)',
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 7,
  },
  actionText: {
    color: '#FFFFFF',
    fontSize: 12,
    fontWeight: '700',
  },
  dismiss: {
    padding: 2,
  },
});
