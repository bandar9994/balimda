// Balimda — © 2026 Bandar Altariqi. All rights reserved.
// Licensed under the Balimda License (see LICENSE): non-commercial use only;
// keep the Balimda name and the "Balimda by Bandar Altariqi" credit; no rebranding.

package com.bandar9994.balimda;

import android.accounts.Account;
import android.app.Activity;
import android.content.Intent;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.content.pm.Signature;
import android.os.Build;
import androidx.activity.result.ActivityResult;
import androidx.activity.result.ActivityResultLauncher;
import androidx.activity.result.IntentSenderRequest;
import androidx.activity.result.contract.ActivityResultContracts;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.google.android.gms.auth.GoogleAuthUtil;
import com.google.android.gms.auth.api.identity.AuthorizationRequest;
import com.google.android.gms.auth.api.identity.AuthorizationResult;
import com.google.android.gms.auth.api.identity.Identity;
import com.google.android.gms.auth.api.identity.RevokeAccessRequest;
import com.google.android.gms.common.api.ApiException;
import com.google.android.gms.common.api.CommonStatusCodes;
import com.google.android.gms.common.api.Scope;
import java.security.MessageDigest;
import java.util.Collections;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Google sign-in for Drive sync, using Google Play services' account picker.
 * Balimda only asks for its own hidden app folder in Drive (drive.appdata).
 * Play services keeps the grant and renews access tokens, so nothing secret
 * is stored by the app.
 *
 * Google recognises the app by its package name and signing certificate
 * (an "Android" OAuth client in Google Cloud), so no client id is needed here.
 */
@CapacitorPlugin(name = "GoogleAuth")
public class GoogleAuthPlugin extends Plugin {

    private static final String DRIVE_APPDATA = "https://www.googleapis.com/auth/drive.appdata";
    private static final List<Scope> SCOPES = Collections.singletonList(new Scope(DRIVE_APPDATA));

    private final ExecutorService background = Executors.newSingleThreadExecutor();
    private ActivityResultLauncher<IntentSenderRequest> launcher;
    private PluginCall pending;

    @Override
    public void load() {
        launcher = getActivity().registerForActivityResult(new ActivityResultContracts.StartIntentSenderForResult(), this::onResult);
    }

    /** { interactive: boolean } -> { accessToken } */
    @PluginMethod
    public void authorize(PluginCall call) {
        boolean interactive = Boolean.TRUE.equals(call.getBoolean("interactive", false));
        AuthorizationRequest request = AuthorizationRequest.builder().setRequestedScopes(SCOPES).build();
        Identity.getAuthorizationClient(getActivity())
            .authorize(request)
            .addOnSuccessListener(result -> {
                if (!result.hasResolution()) {
                    resolveWith(call, result);
                    return;
                }
                if (!interactive || result.getPendingIntent() == null) {
                    call.reject("Sign in to Google again in Settings → Sync.", "NEEDS_SIGN_IN");
                    return;
                }
                if (pending != null) pending.reject("Google sign-in was restarted.", "CANCELLED");
                pending = call;
                launcher.launch(new IntentSenderRequest.Builder(result.getPendingIntent().getIntentSender()).build());
            })
            .addOnFailureListener(e -> reject(call, e));
    }

    private void onResult(ActivityResult activityResult) {
        PluginCall call = pending;
        pending = null;
        if (call == null) return;
        // Google also closes this screen by itself when something is set up
        // wrong, so read its answer rather than assuming the user cancelled.
        Intent data = activityResult.getData();
        if (data == null) {
            if (activityResult.getResultCode() == Activity.RESULT_OK) call.reject("Google sign-in failed. Try again.");
            else call.reject("Google sign-in was closed before it finished. If you didn't close it, check that your Google account is a test user of the app.", "CANCELLED");
            return;
        }
        try {
            AuthorizationResult result = Identity.getAuthorizationClient(getActivity()).getAuthorizationResultFromIntent(data);
            resolveWith(call, result);
        } catch (ApiException e) {
            reject(call, e);
        }
    }

    private void resolveWith(PluginCall call, AuthorizationResult result) {
        String token = result.getAccessToken();
        if (token == null) {
            call.reject("Google did not return an access token. Try again.");
            return;
        }
        JSObject ret = new JSObject();
        ret.put("accessToken", token);
        call.resolve(ret);
    }

    private void reject(PluginCall call, Exception e) {
        if (e instanceof ApiException) {
            int status = ((ApiException) e).getStatusCode();
            String text = e.getMessage() != null ? e.getMessage() : "";
            if (status == CommonStatusCodes.DEVELOPER_ERROR || text.contains("UNREGISTERED_ON_API_CONSOLE")) {
                call.reject("Google doesn't recognise this app yet (code " + status + "). In Google Cloud → Google Auth Platform → Clients, "
                    + "create an Android client in the same project as the consent screen with package " + getContext().getPackageName()
                    + " and SHA-1 " + signingSha1() + ". A new or changed client can take a few minutes to start working.", "DEVELOPER_ERROR", e);
                return;
            }
            if (status == CommonStatusCodes.NETWORK_ERROR) {
                call.reject("No internet connection.", "NETWORK", e);
                return;
            }
            if (status == CommonStatusCodes.CANCELED || status == 12501) {
                call.reject("Google sign-in was cancelled (code " + status + ").", "CANCELLED", e);
                return;
            }
            String detail = e.getMessage() != null ? e.getMessage() : "";
            call.reject("Google sign-in failed (code " + status + "). " + detail, String.valueOf(status), e);
            return;
        }
        call.reject(e.getMessage() != null ? e.getMessage() : "Google sign-in failed.", e);
    }

    /** SHA-1 of the certificate this copy of the app is signed with, as Google Cloud shows it. */
    @SuppressWarnings("deprecation")
    private String signingSha1() {
        try {
            PackageManager pm = getContext().getPackageManager();
            String pkg = getContext().getPackageName();
            Signature[] signatures;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                PackageInfo info = pm.getPackageInfo(pkg, PackageManager.GET_SIGNING_CERTIFICATES);
                signatures = info.signingInfo.getApkContentsSigners();
            } else {
                signatures = pm.getPackageInfo(pkg, PackageManager.GET_SIGNATURES).signatures;
            }
            byte[] digest = MessageDigest.getInstance("SHA-1").digest(signatures[0].toByteArray());
            StringBuilder sb = new StringBuilder();
            for (int i = 0; i < digest.length; i++) {
                if (i > 0) sb.append(':');
                sb.append(String.format("%02X", digest[i]));
            }
            return sb.toString();
        } catch (Exception e) {
            return "(unknown)";
        }
    }

    /** { token } Forget a cached access token that Google Drive rejected. */
    @PluginMethod
    public void clearToken(PluginCall call) {
        String token = call.getString("token");
        background.execute(() -> {
            try {
                if (token != null) GoogleAuthUtil.clearToken(getContext(), token);
            } catch (Exception ignored) {
                // a token that can't be cleared will simply expire
            }
            call.resolve();
        });
    }

    /** { email } Remove Balimda's access to the user's Google account. */
    @PluginMethod
    public void signOut(PluginCall call) {
        String email = call.getString("email");
        if (email == null || email.isEmpty()) {
            call.resolve();
            return;
        }
        RevokeAccessRequest request = RevokeAccessRequest.builder()
            .setAccount(new Account(email, "com.google"))
            .setScopes(SCOPES)
            .build();
        Identity.getAuthorizationClient(getActivity())
            .revokeAccess(request)
            .addOnSuccessListener(unused -> call.resolve())
            .addOnFailureListener(e -> call.resolve());
    }
}
