sap.ui.define([
    'jquery.sap.global',
    "sap/dm/dme/podfoundation/controller/PluginViewController",
    "sap/ui/model/json/JSONModel",
    "./Utils/Commons",
    "./Utils/ApiPaths",
    "../model/formatter",
    "sap/ui/core/Element",
    "sap/m/MessageBox"
], function (jQuery, PluginViewController, JSONModel, Commons, ApiPaths, formatter, Element, MessageBox) {
    "use strict";

    var gOperationPhase = {};
    const OPERATION_STATUS = { ACTIVE: "ACTIVE", QUEUED: "IN_QUEUE" }

    return PluginViewController.extend("serviacero.custom.plugins.zpluginPutBatchOA.zpluginPutBatchOA.controller.MainView", {
        Commons: Commons,
        ApiPaths: ApiPaths,
        formatter: formatter,
        onInit: function () {
            PluginViewController.prototype.onInit.apply(this, arguments);
            this.oScanInput = this.byId("scanInput");
            this._oScanDebounceTimer = null;
            this.sAcActivity = "";       // Guardar valor SET_UP_STATUS de la actividad

            // Modelo "orderSummary" 
            const oOrderSummaryModel = new JSONModel({
                lote: "",
                material: "",
                descripcion: "",
                cantidadNecesaria: 0,
                cantidadEscaneada: 0
            });
            this.getView().setModel(oOrderSummaryModel, "orderSummary");

        },
        onAfterRendering: function () {
            this.onGetCustomValues();
            this.setOrderSummary();
            this.oScanInput.setValue("");
            this.oScanInput.focus();
        },

        onGetCustomValues: function () {
            const oView = this.getView(),
                oSapApi = this.getPublicApiRestDataSourceUri(),
                oTable = oView.byId("idSlotTable"),
                oPODParams = this.Commons.getPODParams(this.getOwnerComponent()),
                url = oSapApi + this.ApiPaths.OPERATION_ACTIVITIES,

                oParams = {
                    plant: oPODParams.PLANT_ID,
                    operation: oPODParams.OPERATION_ACTIVITY
                };

            this.ajaxGetRequest(url, oParams, function (oRes) {
                // content es un array paginado, tomamos el primer elemento
                var aContent = oRes.content || [];
                var oData = aContent[0];

                if (!oData) {
                    console.error("No se encontraron detalles de la actividad de operación");
                    return;
                }

                // Guardar la respuesta completa para uso en updates
                this._oOperationActivityData = oData;

                var aCustomValues = oData.customValues || [];

                // Leer SET_UP_STATUS
                var acActivity = aCustomValues.find(function (el) { return el.attribute === "SET_UP_STATUS"; });
                this.sAcActivity = (acActivity && acActivity.value) || "";

                // Leer ASSIGNED_BATCHES → JSON array
                var oBatchesCv = aCustomValues.find(function (el) { return el.attribute === "ASSIGNED_BATCHES"; });
                var sBatchesJson = (oBatchesCv && oBatchesCv.value) || "[]";
                var aBatches = [];
                try {
                    aBatches = JSON.parse(sBatchesJson);
                } catch (e) {
                    console.error("Error parseando ASSIGNED_BATCHES:", e);
                    aBatches = [];
                }

                // Setear los datos en la tabla (solo batches sin StartDate = pendientes)
                var aVisible = aBatches.filter(function (b) { return !b.StartDate; });
                oTable.setModel(new sap.ui.model.json.JSONModel({ ITEMS: aVisible }));
                this._updateOrderSummaryScannedQty(aVisible);

            }.bind(this));
        },
        onBarcodeSubmit: function () {
            var oView = this.getView();
            var oInput = oView.byId("scanInput");
            var sBarcode = oInput.getValue().trim();
            var oBundle = oView.getModel("i18n").getResourceBundle();

            if (!sBarcode) { return; }

            var sNormalizado = sBarcode.toUpperCase();
            var partsBarcode = sNormalizado.split('!');

            if (partsBarcode.length < 2 || !partsBarcode[0] || !partsBarcode[1]) {
                sap.m.MessageToast.show(oBundle.getText("batchNotExists"));
                oInput.setValue(""); oInput.focus();
                return;
            }

            var sMaterial = partsBarcode[0].trim();
            var sLote = partsBarcode[1].trim();

            // Verificar duplicado por Material + Batch
            var oTable = oView.byId("idSlotTable");
            var oModel = oTable.getModel();
            var aItems = (oModel && oModel.getProperty("/ITEMS")) || [];
            var oExiste = aItems.find(function (b) {
                return (b.Material || "").toUpperCase() === sMaterial &&
                    (b.Batch || "").toUpperCase() === sLote;
            });

            if (oExiste) {
                sap.m.MessageToast.show(oBundle.getText("barcodeExists", [sBarcode]));
                oInput.setValue(""); oInput.focus();
                return;
            }

            this._validarMaterialYLote(sLote, sMaterial);
        },
        /**
         * Refresca las cantidades de todos los batches asignados,
         * consultando getReservas para cada Material/Batch. Solo lectura, no persiste.
         */
        onPressRefresh: function () {
            var oView = this.getView();
            var oTable = oView.byId("idSlotTable");
            var oModel = oTable.getModel();
            var aItems = (oModel && oModel.getProperty("/ITEMS")) || [];
            var oBundle = oView.getModel("i18n").getResourceBundle();
            var oPODParams = this.Commons.getPODParams(this.getOwnerComponent());
            var mandante = this.getConfiguration().mandante;
            var oSapApi = this.getPublicApiRestDataSourceUri();
            var urlLote = oSapApi + this.ApiPaths.getReservas;

            // Filtrar batches con Material y Batch
            var aBatchesConValor = aItems.filter(function (item) {
                return item.Material && item.Batch;
            });

            if (aBatchesConValor.length === 0) {
                sap.m.MessageToast.show(oBundle.getText("sinLotesParaRefrescar"));
                return;
            }

            oView.byId("idPluginPanel").setBusy(true);

            var aPromises = aBatchesConValor.map(function (batch) {
                var inParams = {
                    "inPlanta": oPODParams.PLANT_ID,
                    "inLote": batch.Batch,
                    "inOrden": oPODParams.ORDER_ID,
                    "inSapClient": mandante,
                    "inMaterial": batch.Material,
                    "inPuesto": oPODParams.WORK_CENTER
                };

                return new Promise(function (resolve) {
                    this.ajaxPostRequest(urlLote, inParams,
                        function (oRes) {
                            batch.Quantity = parseFloat(this._formatLoteQty(oRes.outCantidadLote)) || 0;
                            resolve({ batch: batch, ok: true });
                        }.bind(this),
                        function () {
                            resolve({ batch: batch, ok: false });
                        }.bind(this)
                    );
                }.bind(this));
            }.bind(this));

            Promise.all(aPromises).then(function (aResults) {
                oView.byId("idPluginPanel").setBusy(false);
                oModel.refresh(true);
                this._updateOrderSummaryScannedQty(aItems);

                var iFailed = aResults.filter(function (r) { return !r.ok; }).length;
                if (iFailed > 0) {
                    sap.m.MessageToast.show(oBundle.getText("refreshParcial", [iFailed]));
                } else {
                    sap.m.MessageToast.show(oBundle.getText("refreshExitoso"));
                }
            }.bind(this));
        },
        onPressClear: function () {
            const oView = this.getView(),
                oResBun = oView.getModel("i18n").getResourceBundle();
            this.Commons.showConfirmDialog(function () {
                this.clearModel();
            }.bind(this), null, oResBun.getText("clearWarningMessage"));
        },
        clearModel: function () {
            var oView = this.getView();
            var oTable = oView.byId("idSlotTable");
            var oScanInput = oView.byId("scanInput");
            var oModel = oTable.getModel();
            var oBundle = oView.getModel("i18n").getResourceBundle();

            var aItems = (oModel && oModel.getProperty("/ITEMS")) || [];
            if (aItems.length === 0) {
                sap.m.MessageToast.show(oBundle.getText("noDataToClear"));
                return;
            }

            // Vaciar el array y actualizar UI
            oModel.setProperty("/ITEMS", []);
            oModel.refresh(true);
            this._updateOrderSummaryScannedQty([]);
            oScanInput.setValue("");
            oScanInput.focus();

            // Guardar array vacío en backend
            this._saveAssignedBatches([]).then(function () {
                sap.m.MessageToast.show(oBundle.getText("dataClearedSuccess"));
            }.bind(this)).catch(function () {
                sap.m.MessageToast.show(oBundle.getText("errorClearing"));
                this.onGetCustomValues();
            }.bind(this));
        },
        /**
        * Llamada al Pp(getReservas) para obtener los lotes en Reserva y hacer validacion de material
        * @param {string} sLote - Valor del lote "material!lote" 
        * @param {string} sMaterial - Valor del material "material!lote" 
        * @param {string} bAcActivityValidado - Valor de actividad
        * @returns {string} - Solo el material
        */
        _validarMaterialYLote: function (sLote, sMaterial, bAcActivityValidado) {
            const oView = this.getView();
            const oBundle = this.getView().getModel("i18n").getResourceBundle();
            const mandante = this.getConfiguration().mandante;
            const oPODParams = this.Commons.getPODParams(this.getOwnerComponent());
            const oInput = oView.byId("scanInput");
            const loteEscaneado = sLote;
            const materialEscaneado = sMaterial;
            const puesto = oPODParams.WORK_CENTER;
            const sAcActivity = this.sAcActivity;  //customValue AC_ACTIVITY 
            const bEsPuestoCritico = ["TA01", "TA02", "SL02"].includes(puesto);

            // Validación de estatus de operación (en tiempo real desde POD)
            const sCurrentStatus = this._getCurrentOperationStatus();

            if (sCurrentStatus !== OPERATION_STATUS.ACTIVE) {
                sap.m.MessageBox.error(oBundle.getText("verificarStatusOperacion"));
                oInput.setValue("");
                oInput.focus();
                return;
            }

            // validación de actividad (refrescar SET_UP_STATUS en puestos críticos)
            if (bEsPuestoCritico && bAcActivityValidado !== true) {
                this._refreshBatchesFromBackend().then(function (oRefresh) {
                    if (!oRefresh) {
                        sap.m.MessageBox.error(oBundle.getText("errorRefrescarSlots"));
                        return;
                    }
                    var sSetUpRefrescado = (this.sAcActivity || "").trim().toUpperCase();

                    if (sSetUpRefrescado !== "SETUP") {
                        sap.m.MessageBox.error(oBundle.getText("acActivityNotSetup"));
                        oInput.setValue("");
                        oInput.focus();
                        return;
                    }

                    this._validarMaterialYLote(loteEscaneado, materialEscaneado, true);
                }.bind(this));
                return;
            }

            if (bEsPuestoCritico) {
                const sAcActivityNormalizado = ((sAcActivity || "") + "").trim().toUpperCase();
                if (sAcActivityNormalizado !== "SETUP") {
                    sap.m.MessageBox.error(oBundle.getText("acActivityNotSetup"));
                    oInput.setValue("");
                    oInput.focus();
                    return;
                }
            }

            // validacion de material
            const oSapApi = this.getPublicApiRestDataSourceUri();
            const urlMaterial = oSapApi + this.ApiPaths.validateMaterialEnOrden;
            var inParamsMaterial = {
                "inPlanta": oPODParams.PLANT_ID,
                "inLote": loteEscaneado,
                "inOrden": oPODParams.ORDER_ID,
                "inMaterial": materialEscaneado
            };
            oView.byId("idPluginPanel").setBusy(true);

            this.ajaxPostRequest(urlMaterial, inParamsMaterial,
                // SUCCESS callback de validación de material
                function (oResMat) {
                    const matOk = oResMat && (oResMat.outMaterial === true || oResMat.outMaterial === "true");
                    const msgMat = (oResMat && oResMat.outMensaje) || oBundle.getText("materialNoValido");

                    if (!matOk) {
                        oView.byId("idPluginPanel").setBusy(false);
                        sap.m.MessageToast.show(msgMat);
                        if (!this._slotContext) {
                            oInput.setValue("");
                            oInput.focus();
                        }
                        this._slotContext = null;
                        return;
                    }

                    //Validacion de lotes  
                    var urlLote = oSapApi + this.ApiPaths.getReservas;
                    var inParamsLote = {
                        "inPlanta": oPODParams.PLANT_ID,
                        "inLote": loteEscaneado,
                        "inOrden": oPODParams.ORDER_ID,
                        "inSapClient": mandante,
                        "inMaterial": materialEscaneado,
                        "inPuesto": oPODParams.WORK_CENTER
                    };

                    this.ajaxPostRequest(urlLote, inParamsLote,
                        // SUCCESS callback de validación de lote
                        function (oResponseData) {
                            const idInventory = oResponseData && oResponseData.outIdInventory ? oResponseData.outIdInventory : "";
                            oView.byId("idPluginPanel").setBusy(false);

                            var bEsValido = false;
                            if (oResponseData.outLote === "true" || oResponseData.outLote === true) {
                                bEsValido = true;
                            } else if (oResponseData.outLote === "false" || oResponseData.outLote === false) {
                                bEsValido = false;
                            }

                            if (bEsValido) {
                                const sCantidadLote = this._formatLoteQty(oResponseData.outCantidadLote);
                                // Detectar de dónde vino el escaneo
                                if (!this._slotContext) {
                                    // Viene del input superior → buscar slot vacío
                                    this._ejecutarUpdate(sCantidadLote, idInventory);
                                } else {
                                    // Viene del botón por fila → actualizar ese slot
                                    this._slotContext.loteQty = sCantidadLote;
                                    this._procesarSlotValidado(sCantidadLote, idInventory);
                                }
                            } else {
                                sap.m.MessageToast.show(oBundle.getText("loteNoValido"));
                                // Solo limpiar input si viene del input superior
                                if (!this._slotContext) {
                                    oInput.setValue("");
                                    oInput.focus();
                                }
                                // Limpiar contexto siempre
                                this._slotContext = null;
                            }
                        }.bind(this),
                        // ERROR callback de validación de lote
                        function (oError, sHttpErrorMessage) {
                            oView.byId("idPluginPanel").setBusy(false);
                            var err = oError || sHttpErrorMessage;
                            sap.m.MessageToast.show(oBundle.getText("errorValidarLote", [err]));

                            // Solo limpiar input si viene del input superior
                            if (!this._slotContext) {
                                oInput.setValue("");
                                oInput.focus();
                            }
                            // Limpiar contexto siempre
                            this._slotContext = null;
                        }.bind(this)
                    );
                }.bind(this),
                // ERROR callback de validación de material
                function (oError, sHttpErrorMessage) {
                    oView.byId("idPluginPanel").setBusy(false);
                    sap.m.MessageToast.show(oBundle.getText("errorValidacionMaterial", [sHttpErrorMessage || ""]));
                    // Solo limpiar input si viene del input superior
                    if (!this._slotContext) {
                        oInput.setValue("");
                        oInput.focus();
                    }
                    // Limpiar contexto siempre
                    this._slotContext = null;
                }.bind(this)
            );
        },
        _formatLoteQty: function (vCantidad) {
            var n = parseFloat(vCantidad);
            return isNaN(n) ? "" : n.toFixed(2);
        },
        /**
         * Refresca los batches desde el backend (Operation Activity API).
         * Garantiza que antes de cualquier escritura, la tabla refleje el estado REAL.
         * @returns {Promise<{batches: Array, customValues: Array}|null>} null si hubo error
         */
        _refreshBatchesFromBackend: function () {
            var oView = this.getView();
            var oSapApi = this.getPublicApiRestDataSourceUri();
            var oTable = oView.byId("idSlotTable");
            var oPODParams = this.Commons.getPODParams(this.getOwnerComponent());
            var url = oSapApi + this.ApiPaths.OPERATION_ACTIVITIES;
            var oParams = {
                plant: oPODParams.PLANT_ID,
                operation: oPODParams.OPERATION_ACTIVITY
            };

            return new Promise(function (resolve) {
                this.ajaxGetRequest(url, oParams, function (oRes) {
                    var aContent = oRes.content || [];
                    var oData = aContent[0];

                    if (!oData) {
                        resolve(null);
                        return;
                    }

                    this._oOperationActivityData = oData;
                    var aCustomValues = oData.customValues || [];

                    // Refrescar SET_UP_STATUS
                    var acActivity = aCustomValues.find(function (el) { return el.attribute === "SET_UP_STATUS"; });
                    this.sAcActivity = (acActivity && acActivity.value) || "";

                    // Parsear ASSIGNED_BATCHES
                    var oBatchesCv = aCustomValues.find(function (el) { return el.attribute === "ASSIGNED_BATCHES"; });
                    var sBatchesJson = (oBatchesCv && oBatchesCv.value) || "[]";
                    var aBatches = [];
                    try {
                        aBatches = JSON.parse(sBatchesJson);
                    } catch (e) {
                        console.error("Error parseando ASSIGNED_BATCHES:", e);
                        aBatches = [];
                    }

                    // Tabla: solo batches sin StartDate (pendientes)
                    var aVisible = aBatches.filter(function (b) { return !b.StartDate; });
                    oTable.setModel(new sap.ui.model.json.JSONModel({ ITEMS: aVisible }));
                    this._updateOrderSummaryScannedQty(aVisible);

                    resolve({ batches: aBatches, customValues: aCustomValues });
                }.bind(this), function () {
                    resolve(null);
                }.bind(this));
            }.bind(this));
        },
        /**
         * Agrega un nuevo batch escaneado (desde input superior) al array ASSIGNED_BATCHES.
         * FLUJO: _refreshBatchesFromBackend() → validar duplicados → construir objeto → append → PATCH
         * @param {string} sCantidadLote - Cantidad del lote formateada (ej: "150.00")
         * @param {string} inventoryId - ID del inventario
         */
        _ejecutarUpdate: function (sCantidadLote, inventoryId) {
            var oView = this.getView();
            var oInput = oView.byId("scanInput");
            var sBarcode = oInput.getValue().trim();
            var oBundle = oView.getModel("i18n").getResourceBundle();

            this._refreshBatchesFromBackend().then(function (oRefresh) {
                if (!oRefresh) {
                    sap.m.MessageToast.show(oBundle.getText("errorRefrescarSlots"));
                    oInput.setValue(""); oInput.focus();
                    return;
                }

                var aBatches = oRefresh.batches;
                var parts = sBarcode.toUpperCase().split('!');
                var sMaterial = parts[0].trim();
                var sLote = parts[1].trim();

                // Verificar duplicado en datos frescos
                var oExiste = aBatches.find(function (b) {
                    return (b.Material || "").toUpperCase() === sMaterial &&
                        (b.Batch || "").toUpperCase() === sLote;
                });

                if (oExiste) {
                    sap.m.MessageToast.show(oBundle.getText("barcodeExists", [sBarcode]));
                    oInput.setValue(""); oInput.focus();
                    return;
                }

                // Construir nuevo objeto batch
                var oNewBatch = {
                    Material: sMaterial,
                    Batch: sLote,
                    IdInv: inventoryId,
                    Status: "INST",
                    StartDate: "",
                    EndDate: "",
                    UUID: Date.now().toString(36) + Math.random().toString(36).substring(2, 8),
                    GoodsReceipt: false,
                    Quantity: parseFloat(sCantidadLote) || 0
                };

                aBatches.push(oNewBatch);

                var oTable = oView.byId("idSlotTable");
                var aVisible = aBatches.filter(function (b) { return !b.StartDate; });
                oTable.setModel(new sap.ui.model.json.JSONModel({ ITEMS: aVisible }));
                this._updateOrderSummaryScannedQty(aVisible);
                oInput.setValue(""); oInput.focus();

                this._saveAssignedBatches(aBatches).then(function () {
                    sap.m.MessageToast.show(oBundle.getText("slotActualizado"));
                }).catch(function () {
                    sap.m.MessageToast.show(oBundle.getText("errorActualizar"));
                });
            }.bind(this));
        },
        onScanSuccess: function (oEvent) {
            const oBundle = this.getView().getModel("i18n").getResourceBundle();
            if (oEvent.getParameter("cancelled")) {
                sap.m.MessageToast.show(oBundle.getText("scanCancelled"), { duration: 1000 });
            } else {
                if (oEvent.getParameter("text")) {
                    this.oScanInput.setValue(oEvent.getParameter("text"));
                    this.onBarcodeSubmit();
                } else {
                    this.oScanInput.setValue('');
                }
            }
        },
        onScanError: function (oEvent) {
            const oBundle = this.getView().getModel("i18n").getResourceBundle();
            sap.m.MessageToast.show(oBundle.getText("scanFailed", [oEvent]), { duration: 1000 });
        },
        onScanLiveupdate: function (oEvent) {
            if (this._oScanDebounceTimer) {
                clearTimeout(this._oScanDebounceTimer);
            }
            this._oScanDebounceTimer = setTimeout(function () {
                this._oScanDebounceTimer = null;
                this.onBarcodeSubmit();
            }.bind(this), 400);
        },
        /**
         * Actualiza la cantidad asignada (AmountAllocated) de un batch específico.
         * El usuario modifica el input de la fila y presiona el botón para confirmar.
         * FLUJO: Leer UUID + AmountAllocated del modelo → validar → _refreshBatchesFromBackend → update → PATCH
         */
        onAddQty: function (oEvent) {
            var oView = this.getView();
            var oBundle = oView.getModel("i18n").getResourceBundle();
            var oTable = this.byId("idSlotTable");
            var oModel = oTable.getModel();

            // Capturar UUID y cantidad ANTES del refresh (binding bidireccional ya actualizó el modelo)
            var oItem = oEvent.getSource().getParent();
            var iCurrentIndex = oTable.indexOfItem(oItem);
            if (iCurrentIndex === -1) { return; }

            var aCurrentItems = (oModel && oModel.getProperty("/ITEMS")) || [];
            var oBatch = aCurrentItems[iCurrentIndex];
            if (!oBatch || !oBatch.UUID) { return; }

            var sUUID = oBatch.UUID;
            var nNewAmount = parseFloat(oBatch.Quantity);

            if (isNaN(nNewAmount) || nNewAmount <= 0) {
                sap.m.MessageToast.show(oBundle.getText("cantidadInvalida"));
                return;
            }

            oView.byId("idPluginPanel").setBusy(true);

            this._refreshBatchesFromBackend().then(function (oRefresh) {
                oView.byId("idPluginPanel").setBusy(false);
                if (!oRefresh) {
                    sap.m.MessageToast.show(oBundle.getText("errorRefrescarSlots"));
                    return;
                }

                var aBatches = oRefresh.batches;
                var iIndex = aBatches.findIndex(function (b) { return b.UUID === sUUID; });

                if (iIndex === -1) {
                    sap.m.MessageToast.show(oBundle.getText("loteYaEliminado"));
                    return;
                }

                aBatches[iIndex].Quantity = nNewAmount;

                var aVisible = aBatches.filter(function (b) { return !b.StartDate; });
                oTable.setModel(new sap.ui.model.json.JSONModel({ ITEMS: aVisible }));
                this._updateOrderSummaryScannedQty(aVisible);

                this._saveAssignedBatches(aBatches).then(function () {
                    sap.m.MessageToast.show(oBundle.getText("cantidadActualizada"));
                }).catch(function () {
                    sap.m.MessageToast.show(oBundle.getText("errorActualizar"));
                });
            }.bind(this));
        },
        /**
         * Elimina un batch del array ASSIGNED_BATCHES por su UUID.
         * FLUJO: Capturar UUID → _refreshBatchesFromBackend() → buscar por UUID → splice → PATCH
         */
        onDeleteSlot: function (oEvent) {
            var oView = this.getView();
            var oTable = this.byId("idSlotTable");
            var oModel = oTable.getModel();
            var oBundle = oView.getModel("i18n").getResourceBundle();

            // Capturar UUID del item a eliminar ANTES del refresh
            var oItem = oEvent.getSource().getParent();
            var iCurrentIndex = oTable.indexOfItem(oItem);
            if (iCurrentIndex === -1) { return; }

            var aCurrentItems = (oModel && oModel.getProperty("/ITEMS")) || [];
            var sUUIDToDelete = aCurrentItems[iCurrentIndex] && aCurrentItems[iCurrentIndex].UUID;
            if (!sUUIDToDelete) { return; }

            this._refreshBatchesFromBackend().then(function (oRefresh) {
                if (!oRefresh) {
                    sap.m.MessageToast.show(oBundle.getText("errorRefrescarSlots"));
                    return;
                }

                var aBatches = oRefresh.batches;
                var iIndex = aBatches.findIndex(function (b) { return b.UUID === sUUIDToDelete; });

                if (iIndex === -1) {
                    sap.m.MessageToast.show(oBundle.getText("loteYaEliminado"));
                    return;
                }

                aBatches.splice(iIndex, 1);

                var aVisible = aBatches.filter(function (b) { return !b.StartDate; });
                var oFreshModel = oTable.getModel();
                oFreshModel.setProperty("/ITEMS", aVisible);
                oFreshModel.refresh(true);
                this._updateOrderSummaryScannedQty(aVisible);

                sap.m.MessageToast.show(oBundle.getText("loteEliminado"));

                this._saveAssignedBatches(aBatches).then(function () {
                    sap.m.MessageToast.show(oBundle.getText("loteActualizadoAntesEliminar"));
                }).catch(function () {
                    sap.m.MessageBox.error(oBundle.getText("errorActualizarTrasEliminar"));
                });
            }.bind(this));
        },
        /**
         * Callback del escáner por fila. Captura UUID del batch destino y lanza validación.
         */
        onScanSlotSuccess: function (oEvent) {
            var oBundle = this.getView().getModel("i18n").getResourceBundle();

            if (oEvent.getParameter("cancelled")) {
                sap.m.MessageToast.show(oBundle.getText("scanCancelled"), { duration: 1000 });
                return;
            }
            var sBarcode = (oEvent.getParameter("text") || "").trim();
            if (!sBarcode) { return; }

            var parts = sBarcode.toUpperCase().split('!');
            if (parts.length < 2 || !parts[0] || !parts[1]) {
                sap.m.MessageToast.show(oBundle.getText("batchNotExists"));
                return;
            }

            var sMaterial = parts[0].trim();
            var sLote = parts[1].trim();

            // Capturar UUID del batch destino (estable ante refresh, a diferencia del índice DOM)
            var oButton = oEvent.getSource();
            var oSlotItem = oButton.getParent();
            var oTable = this.byId("idSlotTable");
            var iSlotIndex = oTable.indexOfItem(oSlotItem);
            var oSlotModel = oTable.getModel();
            var aCurrentItems = (oSlotModel && oSlotModel.getProperty("/ITEMS")) || [];
            var sTargetUUID = (iSlotIndex >= 0 && aCurrentItems[iSlotIndex]) ? aCurrentItems[iSlotIndex].UUID : null;

            this._slotContext = { sBarcode: sBarcode, loteExtraido: sLote, targetUUID: sTargetUUID };
            this._validarMaterialYLote(sLote, sMaterial);
        },
        /**
         * Procesa la asignación de un barcode validado a un batch específico (escaneo por fila).
         * FLUJO: _refreshBatchesFromBackend() → localizar por UUID → validar duplicados → actualizar → PATCH
         * @param {string} sCantidadLote - Cantidad del lote formateada (ej: "150.00")
         * @param {string} idInventory - ID del inventario
         */
        _procesarSlotValidado: function (sCantidadLote, idInventory) {
            if (!this._slotContext) {
                console.error("No hay contexto de slot");
                return;
            }

            var sBarcode = this._slotContext.sBarcode;
            var sTargetUUID = this._slotContext.targetUUID;
            var oBundle = this.getView().getModel("i18n").getResourceBundle();

            this._refreshBatchesFromBackend().then(function (oRefresh) {
                if (!oRefresh) {
                    sap.m.MessageToast.show(oBundle.getText("errorRefrescarSlots"));
                    this._slotContext = null;
                    return;
                }

                var aBatches = oRefresh.batches;
                var parts = sBarcode.toUpperCase().split('!');
                var sMaterial = parts[0].trim();
                var sLote = parts[1].trim();

                // Verificar duplicado (excluyendo la fila destino)
                var oExiste = aBatches.find(function (b) {
                    if (sTargetUUID && b.UUID === sTargetUUID) return false;
                    return (b.Material || "").toUpperCase() === sMaterial &&
                        (b.Batch || "").toUpperCase() === sLote;
                });

                if (oExiste) {
                    sap.m.MessageToast.show(oBundle.getText("barcodeExists", [sBarcode]));
                    this._slotContext = null;
                    return;
                }

                if (sTargetUUID) {
                    // Actualizar fila existente por UUID
                    var iIndex = aBatches.findIndex(function (b) { return b.UUID === sTargetUUID; });
                    if (iIndex !== -1) {
                        aBatches[iIndex].Material = sMaterial;
                        aBatches[iIndex].Batch = sLote;
                        aBatches[iIndex].IdInv = idInventory;
                        aBatches[iIndex].Quantity = parseFloat(sCantidadLote) || 0;
                    } else {
                        // Fila eliminada externamente → agregar como nuevo
                        aBatches.push({
                            Material: sMaterial,
                            Batch: sLote,
                            IdInv: idInventory,
                            Status: "INST",
                            StartDate: "",
                            EndDate: "",
                            UUID: Date.now().toString(36) + Math.random().toString(36).substring(2, 8),
                            GoodsReceipt: false,
                            Quantity: parseFloat(sCantidadLote) || 0
                        });
                    }
                } else {
                    // Sin UUID destino → agregar como nuevo
                    aBatches.push({
                        Material: sMaterial,
                        Batch: sLote,
                        IdInv: idInventory,
                        Status: "INST",
                        StartDate: "",
                        EndDate: "",
                        UUID: Date.now().toString(36) + Math.random().toString(36).substring(2, 8),
                        GoodsReceipt: false,
                        Quantity: parseFloat(sCantidadLote) || 0
                    });
                }

                var oTable = this.byId("idSlotTable");
                var aVisible = aBatches.filter(function (b) { return !b.StartDate; });
                oTable.setModel(new sap.ui.model.json.JSONModel({ ITEMS: aVisible }));
                this._updateOrderSummaryScannedQty(aVisible);

                this._saveAssignedBatches(aBatches).then(function () {
                    sap.m.MessageToast.show(oBundle.getText("slotActualizado"));
                    this._slotContext = null;
                }.bind(this)).catch(function () {
                    sap.m.MessageToast.show(oBundle.getText("errorActualizar"));
                    this._slotContext = null;
                }.bind(this));
            }.bind(this));
        },
        onBeforeRenderingPlugin: function () {
            // Inicializar gOperationPhase desde POD para capturar estado inicial
            var oPodSelectionModel = this.getPodSelectionModel();
            if (oPodSelectionModel && oPodSelectionModel.selectedPhaseData) {
                var sStatus = oPodSelectionModel.selectedPhaseData.status || "";
                gOperationPhase = {
                    status: sStatus
                };
            }

            this.subscribe("phaseSelectionEvent", this.onPhaseSelectionEventCustom, this);
            this.onGetCustomValues();
        },
        onPhaseSelectionEventCustom: function (sChannelId, sEventId, oData) {
            if (this.isEventFiredByThisPlugin(oData)) {
                return;
            }
            gOperationPhase = oData;
            this.onGetCustomValues();

        },
        isSubscribingToNotifications: function () {
            var bNotificationsEnabled = true;
            return bNotificationsEnabled;
        },
        getCustomNotificationEvents: function (sTopic) {
            //return ["template"];
        },
        getNotificationMessageHandler: function (sTopic) {
            //if (sTopic === "template") {
            //    return this._handleNotificationMessage;
            //}
            return null;
        },
        _handleNotificationMessage: function (oMsg) {

            var sMessage = "Message not found in payload 'message' property";
            if (oMsg && oMsg.parameters && oMsg.parameters.length > 0) {
                for (var i = 0; i < oMsg.parameters.length; i++) {

                    switch (oMsg.parameters[i].name) {
                        case "template":

                            break;
                        case "template2":
                            break;
                    }
                }
            }
        },
        onExit: function () {
            PluginViewController.prototype.onExit.apply(this, arguments);

            this.unsubscribe("phaseSelectionEvent", this.onPhaseSelectionEventCustom, this);
        },
        setOrderSummary: function () {
            const oPODParams = this.Commons.getPODParams(this.getOwnerComponent());
            const oSapApi = this.getPublicApiRestDataSourceUri();
            const order = oPODParams.ORDER_ID;
            var oBundle = this.getView().getModel("i18n").getResourceBundle();
            const oParams = {
                plant: oPODParams.PLANT_ID,
                bom: oPODParams.BOM_ID,
                type: "SHOP_ORDER"
            };

            this.getOrderSummary(oParams, oSapApi)
                .then(function (data) {
                    const oBomData = Array.isArray(data) ? data[0] : data;
                    const aComponents = (oBomData && Array.isArray(oBomData.components)) ? oBomData.components : [];
                    const oNormalComponent = aComponents.find(function (oComp) {
                        return oComp && oComp.componentType === "NORMAL";
                    });

                    if (!oNormalComponent) {
                        console.warn("[OrderSummary] No se encontró componente NORMAL en BOMS", oBomData);
                        return;
                    }

                    const oOrderSummaryModel = this.getView().getModel("orderSummary");
                    const sBatch = oNormalComponent.batchNumber || "";
                    const sMaterial = (oNormalComponent.material && oNormalComponent.material.material) || "";
                    const nCantidadNecesaria = Number(oNormalComponent.totalQuantity || 0);

                    oOrderSummaryModel.setProperty("/lote", sBatch);
                    oOrderSummaryModel.setProperty("/material", sMaterial);
                    oOrderSummaryModel.setProperty("/cantidadNecesaria", nCantidadNecesaria);

                    this.getHeaderMaterial({ material: sMaterial, plant: oPODParams.PLANT_ID }, oSapApi)
                        .then(function (headerData) {
                            const oHeader = Array.isArray(headerData) ? headerData[0] : headerData;
                            const sDescripcion = (oHeader && oHeader.description) || "";
                            oOrderSummaryModel.setProperty("/descripcion", sDescripcion);

                        }.bind(this))
                        .catch(function (error) {
                            console.error("[OrderSummary Test] Error:", error);
                            sap.m.MessageToast.show(oBundle.getText("errorObtenerHeaderMaterial", [sMaterial]));
                        }.bind(this));

                    this._updateOrderSummaryScannedQty();
                }.bind(this))
                .catch(function (error) {
                    console.error("[OrderSummary Test] Error:", error);
                    sap.m.MessageToast.show(oBundle.getText("errorObtenerBom", [order]));
                }.bind(this));
        },
        _updateOrderSummaryScannedQty: function (aItems) {
            const oOrderSummaryModel = this.getView().getModel("orderSummary");
            if (!oOrderSummaryModel) {
                return;
            }

            let aSourceItems = aItems;
            if (!Array.isArray(aSourceItems)) {
                const oTable = this.byId("idSlotTable");
                const oTableModel = oTable && oTable.getModel();
                aSourceItems = (oTableModel && oTableModel.getProperty("/ITEMS")) || [];
            }

            const nScannedQty = aSourceItems.reduce(function (nTotal, oItem) {
                const nQty = parseFloat(oItem && oItem.Quantity);
                return nTotal + (isNaN(nQty) ? 0 : nQty);
            }, 0);

            oOrderSummaryModel.setProperty("/cantidadEscaneada", Number(nScannedQty.toFixed(2)));
        },
        getHeaderMaterial: function (sParams, oSapApi) {
            return new Promise((resolve, reject) => {
                this.ajaxGetRequest(oSapApi + this.ApiPaths.HEADER_MATERIAL, sParams, function (oRes) {
                    resolve(oRes);
                }.bind(this),
                    function (oRes) {
                        reject(oRes);
                    }.bind(this));
            });
        },
        getOrderSummary: function (sParams, oSapApi) {
            return new Promise((resolve, reject) => {
                this.ajaxGetRequest(oSapApi + this.ApiPaths.BOMS, sParams, function (oRes) {
                    resolve(oRes);
                }.bind(this),
                    function (oRes) {
                        reject(oRes);
                    }.bind(this));
            });
        },
        _getCurrentOperationStatus: function () {
            var oPodSelectionModel = this.getPodSelectionModel();
            var sCurrentStatus = "";


            if (oPodSelectionModel && oPodSelectionModel.selectedPhaseData) {
                sCurrentStatus = oPodSelectionModel.selectedPhaseData.status || "";
            }

            if (!sCurrentStatus) {
                var operation = (oPodSelectionModel && typeof oPodSelectionModel.getOperation === "function")
                    ? (oPodSelectionModel.getOperation() && oPodSelectionModel.getOperation().operation)
                    : null;
                if (!operation && gOperationPhase && gOperationPhase.operation) {
                    operation = gOperationPhase.operation.operation || gOperationPhase.operation;
                }
                if (operation) {
                    sCurrentStatus = operation.status || operation.operationStatus || "";
                }
            }

            if (!sCurrentStatus && gOperationPhase) {
                sCurrentStatus = gOperationPhase.status || "";
            }

            return sCurrentStatus;
        },
        /**
         * Persiste el array de batches en el customValue ASSIGNED_BATCHES de la Operation Activity.
         * Usa PP (putBatchSlotOperationActivity) con parámetro inData = OperationActivityUpdateRequest[]
         * @param {Array} aBatches - Array de objetos batch a guardar
         * @returns {Promise} Resolve con la respuesta, reject en error
         */
        _saveAssignedBatches: function (aBatches) {
            var oSapApi = this.getPublicApiRestDataSourceUri();
            var oPODParams = this.Commons.getPODParams(this.getOwnerComponent());
            var oOAData = this._oOperationActivityData;
            var url = oSapApi + this.ApiPaths.putBatchSlotOperationActivity;

            if (!oOAData) {
                return Promise.reject("No operation activity data available");
            }

            // Copiar customValues y actualizar ASSIGNED_BATCHES
            var aCustomValues = (oOAData.customValues || []).map(function (cv) {
                return { attribute: cv.attribute, value: cv.value };
            });

            var oBatchesCv = aCustomValues.find(function (cv) { return cv.attribute === "ASSIGNED_BATCHES"; });
            var sNewValue = JSON.stringify(aBatches);

            if (oBatchesCv) {
                oBatchesCv.value = sNewValue;
            } else {
                aCustomValues.push({ attribute: "ASSIGNED_BATCHES", value: sNewValue });
            }

            // Estructura OperationActivityUpdateRequest para el PP
            var oPayload = {
                inData: [{
                    plant: oOAData.plant || oPODParams.PLANT_ID,
                    operation: oOAData.operation || oPODParams.OPERATION_ACTIVITY,
                    version: oOAData.version || "",
                    customValues: aCustomValues
                }]
            };
            console.log("Payload para guardar batches:", oPayload);
            return new Promise(function (resolve, reject) {
                this.ajaxPostRequest(url, oPayload,
                    function (oRes) { resolve(oRes); }.bind(this),
                    function (oErr) { reject(oErr); }.bind(this)
                );
            }.bind(this));
        },
    });
});