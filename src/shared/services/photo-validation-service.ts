interface PhotoRequirement {
  field: string;
  required: "always" | "if_not_ok" | "never";
  reason: string;
  category:
    | "critical_safety"
    | "legal_protection"
    | "equipment"
    | "documentation";
}

interface ChecklistPhotoValidationResult {
  requiredPhotos: string[];
  optionalPhotos: string[];
  errors: string[];
}

class PhotoValidationService {
  private static readonly PHOTO_RULES: PhotoRequirement[] = [
    // LEGAL PROTECTION - Always mandatory
    {
      field: "current_mileage",
      required: "always",
      reason: "Comprovação da quilometragem para controle legal",
      category: "legal_protection",
    },
    {
      field: "fuel_level_adequate",
      required: "always",
      reason:
        "Evidência do nível de combustível para proteção contra acusações",
      category: "legal_protection",
    },
    {
      field: "tires_condition",
      required: "always",
      reason: "Histórico de desgaste dos pneus para manutenção preventiva",
      category: "legal_protection",
    },

    // CRITICAL SECURITY - Mandatory if not OK
    {
      field: "brakes_working",
      required: "if_not_ok",
      reason: "Evidência obrigatória de problema nos freios por segurança",
      category: "critical_safety",
    },
    {
      field: "headlights_working",
      required: "if_not_ok",
      reason: "Comprovação de defeito nos faróis",
      category: "critical_safety",
    },
    {
      field: "taillights_working",
      required: "if_not_ok",
      reason: "Comprovação de defeito nas lanternas",
      category: "critical_safety",
    },
    {
      field: "turn_signals_working",
      required: "if_not_ok",
      reason: "Evidência de problema nas setas",
      category: "critical_safety",
    },
    {
      field: "steering_wheel_condition",
      required: "if_not_ok",
      reason: "Comprovação de problema na direção por segurança",
      category: "critical_safety",
    },
    {
      field: "battery_condition",
      required: "if_not_ok",
      reason: "Evidência de problema na bateria",
      category: "critical_safety",
    },
    {
      field: "bumpers_condition",
      required: "if_not_ok",
      reason: "Registro de danos nos para-choques",
      category: "legal_protection",
    },
    {
      field: "windshield_condition",
      required: "if_not_ok",
      reason: "Comprovação de danos no para-brisa",
      category: "critical_safety",
    },
    {
      field: "mirrors_condition",
      required: "if_not_ok",
      reason: "Evidência de problema nos retrovisores",
      category: "critical_safety",
    },
    {
      field: "spare_tire_condition",
      required: "if_not_ok",
      reason: "Comprovação do estado do estepe",
      category: "critical_safety",
    },

    // TECHNICAL CHECKS - Mandatory if not OK
    {
      field: "oil_level_adequate",
      required: "if_not_ok",
      reason: "Evidência de nível baixo de óleo",
      category: "critical_safety",
    },
    {
      field: "radiator_water_adequate",
      required: "if_not_ok",
      reason: "Comprovação de nível baixo de água no radiador",
      category: "critical_safety",
    },
    {
      field: "brake_fluid_adequate",
      required: "if_not_ok",
      reason: "Evidência de nível baixo do fluido de freio",
      category: "critical_safety",
    },

    // EQUIPMENT - Optional (easy visual verification)
    {
      field: "fire_extinguisher_valid",
      required: "never",
      reason: "Verificação visual suficiente",
      category: "equipment",
    },
    {
      field: "warning_triangle_present",
      required: "never",
      reason: "Verificação visual suficiente",
      category: "equipment",
    },
    {
      field: "jack_present",
      required: "never",
      reason: "Verificação visual suficiente",
      category: "equipment",
    },

    // DOCUMENTATION - Optional (does not change physically)
    {
      field: "driver_license_valid",
      required: "never",
      reason: "Documento não muda fisicamente",
      category: "documentation",
    },
    {
      field: "vehicle_documents_valid",
      required: "never",
      reason: "Documentos não mudam fisicamente",
      category: "documentation",
    },
    {
      field: "insurance_valid",
      required: "never",
      reason: "Documento não muda fisicamente",
      category: "documentation",
    },

    // INTERNAL ITEMS - Mandatory if not OK
    {
      field: "seatbelts_working",
      required: "if_not_ok",
      reason: "Evidência de problema nos cintos de segurança",
      category: "critical_safety",
    },
    {
      field: "dashboard_working",
      required: "if_not_ok",
      reason: "Comprovação de defeito no painel",
      category: "critical_safety",
    },
    {
      field: "clutch_working",
      required: "if_not_ok",
      reason: "Evidência de problema na embreagem",
      category: "critical_safety",
    },
  ];

  static validatePhotosRequired(
    checklistData: any,
  ): ChecklistPhotoValidationResult {
    const requiredPhotos: string[] = [];
    const optionalPhotos: string[] = [];

    const errors: string[] = [];

    this.PHOTO_RULES.forEach((rule) => {
      const fieldValue = checklistData[rule.field];

      switch (rule.required) {
        case "always":
          requiredPhotos.push(rule.field);
          break;

        case "if_not_ok":
          // For boolean fields, if false = not OK
          if (typeof fieldValue === "boolean" && fieldValue === false) {
            requiredPhotos.push(rule.field);
          }
          // For enum fields, if 'bad' or 'needs_attention' = not OK
          else if (
            typeof fieldValue === "string" &&
            (fieldValue === "bad" || fieldValue === "needs_attention")
          ) {
            requiredPhotos.push(rule.field);
          } else {
            optionalPhotos.push(rule.field);
          }
          break;

        case "never":
          optionalPhotos.push(rule.field);
          break;
      }
    });

    return {
      requiredPhotos,
      optionalPhotos,
      errors,
    };
  }

  static getPhotoRequirementReason(field: string): string {
    const rule = this.PHOTO_RULES.find((r) => r.field === field);
    return rule?.reason || "Foto adicional para documentação";
  }

  static getPhotoRequirementsByCategory() {
    const categories = {
      critical_safety: [] as PhotoRequirement[],
      legal_protection: [] as PhotoRequirement[],
      equipment: [] as PhotoRequirement[],
      documentation: [] as PhotoRequirement[],
    };

    this.PHOTO_RULES.forEach((rule) => {
      categories[rule.category].push(rule);
    });

    return categories;
  }

  static validateRequiredPhotosProvided(
    checklistData: any,
    providedPhotos: { [key: string]: any },
  ): { isValid: boolean; missingPhotos: string[]; errors: string[] } {
    const validation = this.validatePhotosRequired(checklistData);
    const missingPhotos: string[] = [];

    const errors: string[] = [];

    validation.requiredPhotos.forEach((requiredField) => {
      if (
        !providedPhotos[requiredField] ||
        (Array.isArray(providedPhotos[requiredField]) &&
          providedPhotos[requiredField].length === 0)
      ) {
        missingPhotos.push(requiredField);

        const reason = this.getPhotoRequirementReason(requiredField);
        errors.push(`Foto obrigatória para '${requiredField}': ${reason}`);
      }
    });

    return {
      isValid: missingPhotos.length === 0,
      missingPhotos,
      errors,
    };
  }

  // NEW: Enhanced validation for UPDATE operations considering existing photos
  static validateRequiredPhotosForUpdate(
    checklistData: any,
    providedPhotos: { [key: string]: any },
    existingPhotos: string[] = [],
    photosToRemove: string[] = [],
  ): { isValid: boolean; missingPhotos: string[]; errors: string[] } {
    const validation = this.validatePhotosRequired(checklistData);
    const missingPhotos: string[] = [];

    const errors: string[] = [];

    validation.requiredPhotos.forEach((requiredField) => {
      // Check if field has photos after this update
      const hasNewPhotos =
        providedPhotos[requiredField] &&
        Array.isArray(providedPhotos[requiredField]) &&
        providedPhotos[requiredField].length > 0;

      // Check if field has existing photos that won't be removed
      const existingFieldPhotos = existingPhotos.filter(
        (photoUrl) =>
          photoUrl.includes(requiredField) &&
          !photosToRemove.includes(photoUrl),
      );
      const hasRemainingExistingPhotos = existingFieldPhotos.length > 0;

      // Field is valid if it has either new photos OR remaining existing photos
      const hasValidPhotos = hasNewPhotos || hasRemainingExistingPhotos;

      if (!hasValidPhotos) {
        missingPhotos.push(requiredField);
        const reason = this.getPhotoRequirementReason(requiredField);

        errors.push(
          `Foto obrigatória para '${requiredField}': ${reason}. ` +
            `Campo requer foto e não há fotos existentes nem novas fotos fornecidas.`,
        );
      }
    });

    return {
      isValid: missingPhotos.length === 0,
      missingPhotos,
      errors,
    };
  }
}

export {
  PhotoValidationService,
  PhotoRequirement,
  ChecklistPhotoValidationResult,
};
