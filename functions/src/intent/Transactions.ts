import * as admin from "firebase-admin";
import * as functions from "firebase-functions";
import { Transactions } from "../models";
import {
  cloud_function_url_notification,
  placePayment,
  checkPayment,
  serviceKey
} from "../api";
const FieldValue = require("firebase-admin").firestore.FieldValue;
// const axios = require('axios');
const rp = require("request-promise");

export class TransactionsIntent {
  static listenMakePayment = functions.database
    .ref("/intents/make_deposit/{timestamp}/{ref}")
    .onCreate(async (snapshot, context) => {
      const firestore = admin.firestore();
      const realtimeDatabase = admin.database();

      const ref = context.params.ref;
      const timestamp = context.params.timestamp;

      const data = snapshot.val();

      firestore
        .doc(data["userRef"])
        .get()
        .then(userDataSnapshot => {
          if (!userDataSnapshot.exists) {
            realtimeDatabase
              .ref(`/intents/make_deposit/${timestamp}/${ref}/response/code`)
              .ref.set(404);
            return;
          }
          const userData = userDataSnapshot.data();
          const userMoneyAccountRef = firestore.doc(
            `/bucket/moneyAccount/moneyAccounts/${userDataSnapshot.ref.id}`
          );
          console.log(userMoneyAccountRef);
          const transactionRef = userMoneyAccountRef
            .collection("transactions")
            .doc();
          const requestData = {
            service: serviceKey,
            phonenumber: data["phoneNumber"] + "",
            amount: data["amount"],
            notify_url: cloud_function_url_notification,
            item_ref: `/intents/make_deposit/${timestamp}/${ref}/`,
            payment_ref: transactionRef.path,
            user: data["userRef"],
            first_name: userData.firstName,
            last_name: userData.fullName
          };
          if (data["operator"] && data["operator"] === "CM_EUMM") {
            requestData["operator"] = "CM_EUMM";
          }
          console.log(requestData, placePayment);
          const options = {
            method: "POST",
            uri: placePayment,
            json: true,
            body: { ...requestData }
          };

          return rp(options)
            .then(result => {
              console.log(result);
              transactionRef
                .set({
                  ...requestData,
                  ...result,
                  timestamp: FieldValue.serverTimestamp(),
                  type: "deposit"
                })
                .then(() => {
                  console.log(result);
                  if (result.status === "REQUEST_ACCEPTED") {
                    realtimeDatabase
                      .ref(`/intents/make_deposit/${timestamp}/${ref}/response`)
                      .ref.set({
                        code: 202,
                        response: result
                      });
                  } else if (result.status === "INVALID_MSISDN") {
                    realtimeDatabase
                      .ref(`/intents/make_deposit/${timestamp}/${ref}/response`)
                      .ref.set({
                        code: 400,
                        response: result
                      });
                  } else {
                    realtimeDatabase
                      .ref(`/intents/make_deposit/${timestamp}/${ref}/response`)
                      .ref.set({
                        code: 503,
                        response: result
                      });
                  }
                })
                .catch(onrejected => {
                  realtimeDatabase
                    .ref(
                      `/intents/make_deposit/${timestamp}/${ref}/response/code`
                    )
                    .ref.set(500);
                });
            })
            .catch(error => {
              console.log(error);
              realtimeDatabase
                .ref(`/intents/make_deposit/${timestamp}/${ref}/response/code`)
                .ref.set(503);
            });
        })
        .catch(onrejected => {
          console.log("Reject", onrejected);
          realtimeDatabase
            .ref(`/intents/make_deposit/${timestamp}/${ref}/response/code`)
            .ref.set(404);
        });
    });

  static validatePayment(data) {
    return new Promise((resolve, reject) => {
      const firestore = admin.firestore();
      const realtimeDatabase = admin.database();
      firestore
        .doc(data.payment_ref)
        .get()
        .then(async transactionDataSnapshot => {
          if (!transactionDataSnapshot.exists) {
            reject(404);
          }
          const transactionData = transactionDataSnapshot.data();
          const item_ref = data["item_ref"];
          delete data["service"];
          delete data["payment_ref"];
          delete data["item_ref"];

          const options = {
            method: "POST",
            uri: checkPayment,
            json: true,
            body: {
              paymentId: transactionData["paymentId"]
            }
          };

          const confirmPayment = await rp(options);
          if (!confirmPayment["transaction"]) reject("error");
          switch (confirmPayment["transaction"]["status"]) {
            case 1:
              data.status = "success";
              break;
            case 0:
              data.status = "failed";
              break;
            default:
              data.status = "cancelled";
              break;
          }
          const userId = transactionData["user"].split("/").pop();
          firestore
            .doc(Transactions.getRefMoneyAccount(userId))
            .get()
            .then(dataSnapshot => {
              let account;
              if (dataSnapshot.exists) {
                account = dataSnapshot.data();
              } else {
                account = {
                  balance: 0,
                  withdrawCount: 0,
                  depositCount: 0,
                  referralCommissionCount: 0
                };
              }
              let newVal = {};
              if (data.status === "success") {
                newVal = {
                  prevAmount: +account["balance"],
                  newAmount: account["balance"] + data.amount
                };
              }
              transactionDataSnapshot.ref
                .set({ ...data, ...newVal }, { merge: true })
                .then(() => {
                  if (data.status === "failed") {
                    realtimeDatabase
                      .ref(`${item_ref}`)
                      .ref.child("response")
                      .set({ code: 406 });
                  } else if (data.status === "cancelled") {
                    realtimeDatabase
                      .ref(`${item_ref}`)
                      .ref.child("response")
                      .set({ code: 412 });
                  } else if (data.status === "success") {
                    if (dataSnapshot.exists) {
                      dataSnapshot.ref
                        .set(
                          {
                            ...account,
                            balance: account["balance"] + data.amount,
                            depositCount: +account["depositCount"] + 1
                          },
                          { merge: true }
                        )
                        .then(() => {
                          realtimeDatabase
                            .ref(`${item_ref}`)
                            .ref.child("response")
                            .set({ code: 201 });
                          resolve(202);
                        });
                    } else {
                      dataSnapshot.ref
                        .set({
                          ...account,
                          balance: account["balance"] + data.amount,
                          depositCount: +account["depositCount"] + 1
                        })
                        .then(() => {
                          realtimeDatabase
                            .ref(`${item_ref}`)
                            .ref.child("response")
                            .set({ code: 201 });
                          resolve(202);
                        });
                    }
                  }
                });
            });
        })
        .catch(onrejected => {
          reject(500);
        });
    });
  }
}
