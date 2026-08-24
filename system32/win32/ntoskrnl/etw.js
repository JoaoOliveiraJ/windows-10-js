// ===========================================================================
// jsOS - system32/win32/ntoskrnl/etw.js: exports ETW (Event Tracing for
// Windows) para drivers. Provedores sao registrados de verdade (tabela por
// GUID) e os eventos escritos viram linhas de trace na serial (o sink do
// jsOS) com o handle do provedor.
// ===========================================================================

const GuestMemory = require('win32/guest-memory');
const GuestStrings = require('win32/guest-strings');

const providers = new Map();   // handle -> { guidText, enabled }
let nextProviderHandle = 0x900;

// GUID da atividade corrente (EtwActivityIdControl GET/SET) + estado do
// gerador de uuid (CREATE_ID)
let etwCurrentActivityIdPointer = 0;
let etwUuidState = 0;

function guidToText(guidPointer) {
    let text = '';
    for (let i = 0; i < 16; i++)
        text += GuestMemory.readGuest8(guidPointer + i).toString(16).padStart(2, '0');
    return text;
}

module.exports = {
    names: [
        'EtwRegister',
        'EtwUnregister',
        'EtwWrite',
        'EtwWriteTransfer',
        'EtwSetInformation',
        'EtwRegisterClassicProvider',
        'EtwActivityIdControl',        // (controlCode, activityIdPtr)
    ],
    handlers: [
        // EtwRegister(providerGuidPtr, enableCallback, callbackCtx, outHandle)
        (guidPointer, _enableCallback, _callbackContext, outHandlePointer) => {
            const handle = nextProviderHandle++;
            providers.set(handle, { guidText: guidToText(guidPointer),
                                    enabled: true });
            GuestMemory.writeGuest64(outHandlePointer, handle);
            return 0;
        },
        // EtwUnregister(handle)
        (providerHandle) => {
            providers.delete(providerHandle >>> 0);
            return 0;
        },
        // EtwWrite(handle, eventDescriptorPtr, activityIdPtr, ...userData)
        (providerHandle, _descriptorPointer, _activityIdPointer) => {
            const provider = providers.get(providerHandle >>> 0);
            os.debugPrint('[etw:' + (provider ? provider.guidText.slice(0, 8)
                                              : '?') + '] evento');
            return 0;
        },
        // EtwWriteTransfer(handle, descriptor, activityId, relatedId, ...)
        (providerHandle, _descriptorPointer, _activityIdPointer,
         _relatedActivityIdPointer) => {
            const provider = providers.get(providerHandle >>> 0);
            os.debugPrint('[etw:' + (provider ? provider.guidText.slice(0, 8)
                                              : '?') + '] transfer');
            return 0;
        },
        // EtwSetInformation(handle, infoClass, infoBuffer, infoSize)
        (providerHandle, informationClass, informationPointer,
         _informationSize) => {
            const provider = providers.get(providerHandle >>> 0);
            if (!provider) return 0xC0000008 | 0;   // STATUS_INVALID_HANDLE
            if ((informationClass >>> 0) === 1 && informationPointer) {
                // EventProviderSetTraits: guarda os traits do provedor
                provider.traitsLength = GuestMemory.readGuest32(informationPointer);
            }
            return 0;
        },
        // EtwRegisterClassicProvider(providerGuidPtr, type, callback, ctx,
        //                            outHandle): variante classica do register
        (guidPointer, _providerType, _enableCallback, _callbackContext,
         outHandlePointer) => {
            const handle = nextProviderHandle++;
            providers.set(handle, { guidText: guidToText(guidPointer),
                                    enabled: true });
            GuestMemory.writeGuest64(outHandlePointer, handle);
            return 0;
        },
        // EtwActivityIdControl(controlCode, activityIdPtr): GET_ID=1, SET_ID=2,
        // CREATE_ID=3, GET_SET_ID=4, CREATE_SET_ID=5 (evntprov.h) — le/grava/
        // gera o GUID de 16 bytes da atividade corrente (estado real)
        (controlCode, activityIdPointer) => {
            const GuestMemoryRef = GuestMemory;
            if (!etwCurrentActivityIdPointer)
                etwCurrentActivityIdPointer = GuestMemoryRef.guestAllocBytes(16);
            const copyFromCurrent = () => {
                for (let i = 0; i < 16; i++)
                    GuestMemoryRef.writeGuest8(activityIdPointer + i,
                        GuestMemoryRef.readGuest8(etwCurrentActivityIdPointer + i));
            };
            const copyToCurrent = () => {
                for (let i = 0; i < 16; i++)
                    GuestMemoryRef.writeGuest8(etwCurrentActivityIdPointer + i,
                        GuestMemoryRef.readGuest8(activityIdPointer + i));
            };
            const generateInto = () => {
                // uuid v4 (xorshift32 semeado no TSC — mesmo padrao do Ex)
                etwUuidState ^= etwUuidState << 13;
                etwUuidState ^= etwUuidState >>> 17;
                etwUuidState ^= etwUuidState << 5;
                if (!etwUuidState) etwUuidState = (os.rdtsc() >>> 0) || 0x2545F491;
                for (let i = 0; i < 4; i++) {
                    etwUuidState ^= etwUuidState << 13;
                    etwUuidState ^= etwUuidState >>> 17;
                    etwUuidState ^= etwUuidState << 5;
                    GuestMemoryRef.writeGuest32(activityIdPointer + i * 4,
                                                etwUuidState >>> 0);
                }
                const byte6 = GuestMemoryRef.readGuest8(activityIdPointer + 6);
                GuestMemoryRef.writeGuest8(activityIdPointer + 6,
                                           (byte6 & 0x0F) | 0x40);
                const byte8 = GuestMemoryRef.readGuest8(activityIdPointer + 8);
                GuestMemoryRef.writeGuest8(activityIdPointer + 8,
                                           (byte8 & 0x3F) | 0x80);
            };
            const code = controlCode >>> 0;
            if (code === 1) copyFromCurrent();                    // GET_ID
            else if (code === 2) copyToCurrent();                 // SET_ID
            else if (code === 3) generateInto();                  // CREATE_ID
            else if (code === 4) { copyFromCurrent(); copyToCurrent(); }
            else if (code === 5) { generateInto(); copyToCurrent(); }
            else return 0xC000000D | 0;   // STATUS_INVALID_PARAMETER
            return 0;
        },
    ],
};
